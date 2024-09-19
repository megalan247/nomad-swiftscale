import * as nomad from './clients/nomad.js'
import * as aws from './clients/aws.js'

import log from 'loglevel';
import chalk from 'chalk';
import prefix from 'loglevel-plugin-prefix';
import crypto from 'crypto'
import { promisify } from 'util';

const wait = promisify(setTimeout);

const colors = {
    TRACE: chalk.magenta,
    DEBUG: chalk.cyan,
    INFO: chalk.blue,
    WARN: chalk.yellow,
    ERROR: chalk.red,
};
prefix.reg(log);

prefix.apply(log, {
    format(level, name, timestamp) {
        return `${chalk.gray(`[${timestamp}]`)} ${colors[level.toUpperCase()](level)}`;
    },
});

prefix.apply(log.getLogger('critical'), {
    format(level, name, timestamp) {
        return chalk.red.bold(`[${timestamp}] ${level} ${name}:`);
    },
});

let isDryRun = !!process.env.DRY_RUN

let scaleUpMemoryUtil = 90 / 100
let scaleDownMemoryUtil = 90 / 100
let medianMemoryUtil = (scaleUpMemoryUtil + scaleDownMemoryUtil) / 2

let scaleUpCpuUtil = 90 / 100
let scaleDownCpuUtil = 90 / 100
let medianCpuUtil = (scaleUpCpuUtil + scaleDownCpuUtil) / 2

let scaleDownStep = 1

let scalingActionCompleted = false

log.setLevel(process.env.LOG_LEVEL || "debug")

async function main() {
    scalingActionCompleted = false
    log.info("Starting Nomad Autoscaler v2")
    if (isDryRun) {
        log.warn("DRY_RUN is set, will not perform any actual actions")
    }
    var totalRequestedResourceUsage = await nomad.getTotalMemoryAndCPUUsage()
    var totalNodeMemoryAndCpu = await nomad.getTotalNodeMemoryAndCPU()
    var utilization = await nomad.getDatacenterUtilization()
    log.info(`Found current CPU cluster utilization to be ${utilization.cpuUtilization} and RAM utilization to be ${utilization.memoryUtilization}`)
    var blockedResourceRequirements = await nomad.getBlockedResourceRequirements()

    // Scaleup if there are any blocked resources
    if (blockedResourceRequirements.totalBlockedMemory || blockedResourceRequirements.totalBlockedCPU) {
        log.info("Scaleup based on blocked evals")
        log.info(`Need to scale up ${JSON.stringify(blockedResourceRequirements)}`)
        let scaleUpCPU = blockedResourceRequirements.totalBlockedCPU / 2000; // This magic number is roughly the CPU frequency in Mhz, and is roughly equivilent to how Nomad calculates CPUShares from num CPUs
        let scaleUpCPUMax = blockedResourceRequirements.maxBlockedCPU / 2000
        var scaleUpInstances = aws.getLeastExpensiveCombination(blockedResourceRequirements.totalBlockedMemory, scaleUpCPU, blockedResourceRequirements.maxBlockedMemory, scaleUpCPUMax)
        log.info(`Found least expensive option of ${JSON.stringify(scaleUpInstances)}`)
        for (var instance of scaleUpInstances) {
            let groupName = "nm-auto-" + crypto.randomBytes(4).toString("hex")
            log.debug(`Will create asg with name ${groupName} and instance type ${instance.type}`)
            if (!isDryRun) {
                await aws.createAutoScalingGroup(groupName, instance.type)
            } else {
                log.debug("DRY RUN, will not create ASG")
            }
            scalingActionCompleted = true
        }
        if (scalingActionCompleted) {
            return
        }
        
    }




    // Scale up if either CPU or RAM can be scaled up

    // if (utilization.cpuUtilization > scaleUpCpuUtil) {
    //     log.info(`Scaleup CPU as CPU util is ${utilization.cpuUtilization}% and threshhold is ${scaleUpCpuUtil}%`)
    //     // Scaleup Logic
    // }

    // if (utilization.memoryUtilization > scaleUpMemoryUtil) {
    //     log.info("Scaleup memory")
    //     // Scaleup Logic
    // }


    // Only scale down if both RAM and CPU can be scaled down

    if (utilization.memoryUtilization < scaleDownMemoryUtil && utilization.cpuUtilization < scaleDownCpuUtil) {
        // Calculate which resource (memory or CPU) is closer to the threashhold (we can only scale down whichever is smaller)
        var memoryDifference = scaleDownMemoryUtil - utilization.memoryUtilization
        var cpuDifference = scaleDownCpuUtil - utilization.cpuUtilization
        if (memoryDifference < cpuDifference) {
            log.info(`Scaledown memory as memory util is ${utilization.memoryUtilization}% and threshhold is ${scaleDownMemoryUtil} (difference of ${memoryDifference})`)
            // Calculate how much to scale down
            let scaleDownTargetMemory = totalRequestedResourceUsage.totalMemory * ((1 - medianMemoryUtil) + 1)
            let scaleDownDifferenceMemory = totalNodeMemoryAndCpu.totalMemory - scaleDownTargetMemory
            log.debug(`Current cluster memory is ${totalNodeMemoryAndCpu.totalMemory} and we want to scale it down to ${scaleDownTargetMemory} (factor ${medianMemoryUtil}, difference ${scaleDownDifferenceMemory})`)
            var potentialNodesToScaleDown = await nomad.determineScaleDownNode(scaleDownDifferenceMemory, "MemoryMB")
        } else {
            log.info(`Scaledown CPU as CPU is ${utilization.cpuUtilization}% and threshhold is ${scaleDownCpuUtil} (difference of ${cpuDifference})`)
            let scaleDownTargetCPU = totalRequestedResourceUsage.totalCPU * ((1 - medianCpuUtil) + 1)
            let scaleDownDifferenceCPU = totalNodeMemoryAndCpu.totalCPU - scaleDownTargetCPU
            log.debug(`Current cluster CPU is ${totalNodeMemoryAndCpu.totalCPU} and we want to scale it down to ${scaleDownTargetCPU} (factor ${medianMemoryUtil}, difference ${scaleDownDifferenceCPU})`)
            var potentialNodesToScaleDown = await nomad.determineScaleDownNode(scaleDownDifferenceCPU, "CPUShares")
        }
        // We only scale down in a single instance the number of nodes specified in scaleDownStep
        log.info(`Picking ${scaleDownStep} node(s) to scale down`)
        const nodesToScaleDown = potentialNodesToScaleDown.slice(0, scaleDownStep);
        for (var node of nodesToScaleDown) {
            scalingActionCompleted = true
            log.debug(`Scaling down node ${node.Name}`)
            if (!isDryRun) {
                await aws.deleteAutoScalingGroupByInstanceId(node.Name.slice(2))
            } else {
                log.debug("DRY RUN, will not terminate instance")
            }
            
        }
        log.info("Scaledown complete")
        if (scalingActionCompleted) {
            return
        }
        
    }
    log.info("Loop completed. No scaling action taken.")
}


async function loop() {
    while (true) {
        await main()
        if (scalingActionCompleted) {
            log.debug("Waiting 300 seconds for next loop")
            await wait(300000)
        } else {
            try {
                await aws.refreshManagedAutoScalingGroups()
            } catch (error) {
                log.error(error)
            }
            
            log.debug("Waiting 60 seconds for next loop")
            await wait(60000)
        }

    }

}

loop()
