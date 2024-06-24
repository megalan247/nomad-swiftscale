import got from 'got';
import log from 'loglevel';
import fs from 'fs';

import Cache from 'cache';

import { promisify } from 'util';

const wait = promisify(setTimeout);


let nomadAddr = process.env.NOMAD_ADDR
let nomadToken = process.env.NOMAD_TOKEN
let nomadDatacenter = process.env.NOMAD_TOKEN
let basicAuthUsername = process.env.NOMAD_AUTH_USERNAME
let basicAuthPassword = process.env.NOMAD_AUTH_PASSWORD
let mtlsCertPath = process.env.NOMAD_CLIENT_CERT
let mtlsKeyPath = process.env.NOMAD_CLIENT_KEY

let c = new Cache(10 * 1000);

async function queryNomadApi(url, data = null, nocache = false) {
    if (!nocache) {
        var cachedResponse = c.get(url);
        if (cachedResponse) {
            log.trace(`Cache hit and response returned for URL ${url}`)
            return cachedResponse
        }
    }
    var reqProperties = {}
    if (data) {
        reqProperties.json = data
    }
    if (nomadToken) {
        if (typeof reqProperties.headers == 'undefined') {
            reqProperties.headers = {}
        }
        reqProperties.headers["X-Nomad-Token"] = nomadToken
    }
    if (basicAuthUsername) {
        reqProperties.username = basicAuthUsername
        reqProperties.password = basicAuthPassword
    }
    if (mtlsCertPath && mtlsKeyPath) {
        reqProperties.https = {
            certificate: fs.readFileSync(mtlsCertPath),
            key: fs.readFileSync(mtlsKeyPath)
        };
    }
    try {
        if (data) {
            var res = await got.post(nomadAddr + url, reqProperties).json();
        } else {
            var res = await got(nomadAddr + url, reqProperties).json();
        }
        c.put(url, res);
        log.debug(`Queried Nomad api with path ${url}`)
        return res
    } catch (error) {
        log.error(`Failed to query Nomad API with path ${url}`)
        log.error(error.response.body)
        throw error
    }
}

async function getNodeStatus() {
    const data = await queryNomadApi("/v1/nodes?resources=true")
    log.trace(`Found ${data.length} nodes`)
    return data
}

async function getFilteredNodes() {
    const data = await getNodeStatus()
    var nodes = []
    for (var node of data) {
        if (node.Status != "ready") {
            continue
        }
        if (node.SchedulingEligibility != "eligible") {
            continue
        }
        if (node.Datacenter != nomadDatacenter) {
            continue
        }
        nodes.push(node)
    }
    log.trace(`Found ${nodes.length} nodes`)
    return nodes
}

async function getNodesById() {
    const data = await getNodeStatus()
    var nodesById = {}
    for (var node of data) {
        nodesById[node.Name] = node
    }
    return nodesById
}

async function getNodeById(nodeId) {
    var nodes = await getNodesById()
    return nodes[nodeId]
}

async function getAllocationStatus() {
    const data = await queryNomadApi("/v1/allocations?resources=true")
    var allocations = []
    for (var allocation of data) {
        if (allocation.ClientStatus == "running" || allocation.ClientStatus == "pending") {
            if (allocation.DesiredStatus != "run") {
                continue
            }

            const nodeId = allocation.NodeName;
            const node = await getNodeById(nodeId);
            const jobDatacenter = node.Datacenter;

            if (jobDatacenter != nomadDatacenter) {
                continue
            }
            allocations.push(allocation)
        }
    }

    log.trace(`Found ${allocations.length} allocations`)
    return allocations
}

async function getEvaluationsStatus() {
    const data = await queryNomadApi("/v1/evaluations")
    log.trace(`Found ${data.length} evaluations`)
    return data
}

async function getEvaluationById(evalId) {
    const data = await getEvaluationsStatus()
    let foundEval = data.find(evaluation => evaluation.ID === evalId)
    return foundEval
}

async function getNumberOfQueuedAllocsByJobAndAllocName(jobId, allocName) {
    var jobs = await getJobs()
    var job = jobs[jobId]
    var summary = job.JobSummary.Summary
    var allocSummary = summary[allocName]
    if (allocSummary) {
        return summary[allocName].Queued
    } else {
        return 1
    }
}

async function getDeploymentsStatus() {
    const data = await queryNomadApi("/v1/deployments")
    log.trace(`Found ${data.length} deployments`)
    return data
}

async function getCurrentDeploymentByJobName(jobName) {
    const data = await getDeploymentsStatus()
    log.trace(`Found ${data.length} evaluations`)
    const deploymentsForJob = data.filter(deployment => deployment.JobID === jobName);

    const runningDeployments = deploymentsForJob.filter(deployment => deployment.Status === 'running');

    if (runningDeployments.length === 0) {
        return null; // no running deployments found
    }

    // return the first running deployment (assuming there is only one)
    return runningDeployments[0];
}

async function getJobDetails(jobName) {
    const data = await queryNomadApi("/v1/job/" + jobName)
    return data
}

async function getJobs() {
    const data = await queryNomadApi("/v1/jobs")
    var jobsById = {}
    for (var job of data) {
        jobsById[job.Name] = job
    }
    return jobsById
}

async function getJobPrio(jobName) {
    var jobs = await getJobs()
    return jobs[jobName].Priority
}

async function getTotalResourceOfAllocInJob(jobName, allocName) {
    var job = await getJobDetails(jobName)
    if (job) {
        log.trace(`Found job with ID ${jobName}`)
        let allocCpuLimit = 0;
        let allocMemLimit = 0;
        let alloc = job.TaskGroups.find(i => i.Name == allocName)
        if (alloc) {
            let count = alloc.Count
            for (const task of alloc.Tasks) {
                allocCpuLimit += task.Resources.CPU;
                allocMemLimit += task.Resources.MemoryMB;
            }
            return {
                count,
                allocCpuLimit,
                allocMemLimit
            }
        } else {
            log.warn(`Cannot find alloc with name ${allocName} in job with name ${jobName}`)
            return false
        }


    } else {
        log.warn(`Cannot find job with name ${jobName}`)
        return false
    }

}

async function getTotalNodeMemoryAndCPU() {
    const nodes = await getFilteredNodes()
    // Calculate the total memory and CPU available on all ready and eligible the nodes in the specified datacenter
    let totalMemory = 0;
    let totalCPU = 0;

    for (const node of nodes) {
        totalMemory += node.NodeResources.Memory.MemoryMB;
        totalCPU += node.NodeResources.Cpu.CpuShares;
    }

    return {
        totalMemory,
        totalCPU
    };
}

async function getSortedNodesByAllocsAndPrio() {
    // This function returns a sorted array of nodes, the first of which are 
    // the most empty and have the least jobs running on them

    // We use the "Job Priority" and the sum of the alloc CPU and memory to determine
    // The "size and importance" of each alloc. We will prioritize draining and removing nodes
    // which have fewer or less-important tasks running on them.
    let allocs = await getAllocationStatus()
    let nodes = await getFilteredNodes()

    const allocCountsByNode = {};

    for (var node of nodes) {
        allocCountsByNode[node.Name] = {};
        allocCountsByNode[node.Name].allocSize = 0
        allocCountsByNode[node.Name].highestJobPriotity = 0
    }

    for (const alloc of allocs) {
        const nodeName = alloc.NodeName;
        var jobPrio = await getJobPrio(alloc.JobID)
        if (jobPrio > allocCountsByNode[nodeName].highestJobPriotity) {
            allocCountsByNode[nodeName].highestJobPriotity = jobPrio
        }
        var resourceUsage = getAllocResourceUsage(alloc)
        var totalResource = resourceUsage.allocationCPU + resourceUsage.allocationMemory
        allocCountsByNode[nodeName].allocSize += totalResource;
    }

    const dataArray = Object.entries(allocCountsByNode).map(([id, obj]) => ({ id, ...obj }));

    dataArray.sort((a, b) => {
        if (a.highestJobPriotity === b.highestJobPriotity) {
            return a.allocSize - b.allocSize;
        }
        return a.highestJobPriotity - b.highestJobPriotity;
    });
    return dataArray;

}


async function determineScaleDownNode(amountToScaleDown, resource) {
    // Function that picks the node(s) to scale down given a value to scale down to
    // Resource is either MemoryMB or CPUShares
    let chosenNodes = []
    let currentScaleDownAmount = 0
    log.debug(`Value to scale down is ${amountToScaleDown} of resource ${resource}`)
    let sortedNodesList = await getSortedNodesByAllocsAndPrio();
    for (var node of sortedNodesList) {
        let nodeInfo = await getNodeById(node.id)
        log.debug(`Retreived node info for node ${node.id}`)
        if (resource == "MemoryMB") {
            if ((currentScaleDownAmount + nodeInfo.NodeResources.Memory.MemoryMB) < amountToScaleDown) {
                if (await canNodeBeDrained(nodeInfo.Name)) {
                    currentScaleDownAmount += nodeInfo.NodeResources.Memory.MemoryMB
                    chosenNodes.push(nodeInfo)
                    log.debug(`Adding node to chosenNodes (MemoryMB ${nodeInfo.NodeResources.Memory.MemoryMB}, amount left to scale down ${amountToScaleDown - currentScaleDownAmount})`)
                } else {
                    log.debug(`Node ${node.id} cannot be drained, and therefore cannot be scaled down`)
                }

            }
        }
        if (resource == "CPUShares") {
            if ((currentScaleDownAmount + nodeInfo.NodeResources.Cpu.CpuShares) < amountToScaleDown) {
                if (await canNodeBeDrained(nodeInfo.Name)) {
                    currentScaleDownAmount += nodeInfo.NodeResources.Cpu.CpuShares
                    chosenNodes.push(nodeInfo)
                    log.debug(`Adding node to chosenNodes (MemoryMB ${nodeInfo.NodeResources.Memory.MemoryMB}, amount left to scale down ${amountToScaleDown - currentScaleDownAmount})`)
                } else {
                    log.debug(`Node ${node.id} cannot be drained, and therefore cannot be scaled down`)
                }
            }
        }
        if (currentScaleDownAmount >= amountToScaleDown) {
            break
        }
    }
    log.debug(`Found ${chosenNodes.length} nodes that we can potentially scale down`)
    return chosenNodes

}

function getAllocResourceUsage(allocation) {
    let allocationMemory = 0;
    let allocationCPU = 0;
    let allocatedResources = allocation.AllocatedResources.Tasks
    for (const task of Object.keys(allocatedResources)) {
        if (allocation?.TaskStates[task]) {
            // If task is running, add resources to the alloc usage
            if (allocation.TaskStates[task].State == "running") {
                allocationMemory += allocatedResources[task].Memory.MemoryMB;
                allocationCPU += allocatedResources[task].Cpu.CpuShares;
            }
            if (allocation.DesiredStatus == "run" && allocation.TaskStates[task].State == "pending") {
                // If the task is pending, but the alloc wants to run, add the resources too
                allocationMemory += allocatedResources[task].Memory.MemoryMB;
                allocationCPU += allocatedResources[task].Cpu.CpuShares;
            }
        }

    }
    return {
        allocationMemory,
        allocationCPU
    }
}

async function getTotalMemoryAndCPUUsage(nodeName) {

    let allocations = await getAllocationStatus();
    if (nodeName) {
        let nodeAllocs = allocations.filter(alloc => alloc.NodeName == nodeName)
        allocations = nodeAllocs
    }
    const nodesById = await getNodesById()
    // Calculate the total memory and CPU usage of all the allocations
    let totalMemory = 0;
    let totalCPU = 0;

    // Find the allocation with the most CPU and RAM allocated
    let maxCPUAllocation;
    let maxMemoryAllocation;

    for (const allocation of allocations) {

        var allocResources = getAllocResourceUsage(allocation)

        let allocationMemory = allocResources.allocationMemory;
        let allocationCPU = allocResources.allocationCPU;

        if (allocationMemory > maxMemoryAllocation?.memory || maxMemoryAllocation === undefined) {
            maxMemoryAllocation = {
                id: allocation.ID,
                memory: allocationMemory
            };
        }

        if (allocationCPU > maxCPUAllocation?.cpu || maxCPUAllocation === undefined) {
            maxCPUAllocation = {
                id: allocation.ID,
                cpu: allocationCPU
            };
        }

        totalMemory += allocationMemory;
        totalCPU += allocationCPU;
    }

    return {
        totalMemory,
        totalCPU,
        maxMemoryAllocation,
        maxCPUAllocation
    };
}

async function getDatacenterUtilization() {
    var totalRequestedResourceUsage = await getTotalMemoryAndCPUUsage()
    var totalNodeMemoryAndCpu = await getTotalNodeMemoryAndCPU()
    const memoryUtilization = (totalRequestedResourceUsage.totalMemory / totalNodeMemoryAndCpu.totalMemory).toFixed(2);
    const cpuUtilization = (totalRequestedResourceUsage.totalCPU / totalNodeMemoryAndCpu.totalCPU).toFixed(2);

    return {
        memoryUtilization,
        cpuUtilization
    };
}

function canJobsBePlaced(jobs, nodes) {
    // Iterate over each job
    for (const job of jobs) {
        let jobPlaced = false;

        // Iterate over each node
        for (const node of nodes) {
            // Check if the node has enough resources to run the job
            if (node.available_memory >= job.memory_mb && node.available_cpu >= job.cpu) {
                // Update the node's available resources
                node.available_memory -= job.memory_mb;
                node.available_cpu -= job.cpu;

                // Mark the job as placed
                jobPlaced = true;
                break;
            }
        }

        // If the job is not placed, return false
        if (!jobPlaced) {
            return false;
        }
    }

    // If all jobs are placed, return true
    return true;
}

async function canNodeBeDrained(nodeName) {
    // THis function checks whether a node can be drained
    let allocStatus = await getAllocationStatus()
    let nodeStatus = await getFilteredNodes()
    let nodeAllocs = allocStatus.filter(alloc => alloc.NodeName == nodeName)
    var allocUsage = []
    for (var alloc of nodeAllocs) {
        let resourceUsage = getAllocResourceUsage(alloc)
        allocUsage.push({
            "cpu": resourceUsage.allocationCPU,
            "memory_mb": resourceUsage.allocationMemory,
            "job_name": alloc.JobID
        })
    }

    let restNodes = nodeStatus.filter(node => node.Name !== nodeName)
    let nodeResourceUsage = []
    for (var node of restNodes) {
        var nodeUsage = await getTotalMemoryAndCPUUsage(node.Name)
        nodeResourceUsage.push({
            available_memory: node.NodeResources.Memory.MemoryMB - node.ReservedResources.Memory.MemoryMB - nodeUsage.totalMemory,
            available_cpu: node.NodeResources.Cpu.CpuShares - node.ReservedResources.Cpu.CpuShares - nodeUsage.totalCPU,
            node_name: node.Name
        })
    }
    let canBeDrained = canJobsBePlaced(allocUsage, nodeResourceUsage)
    if (!canBeDrained) {
        log.debug(`Node ${nodeName} cannot be drained`)
    }
    return canBeDrained

}

async function getBlockedResourceRequirements() {
    // To determine if any allocs cannot be placed due to resource exhaustion, we need to query the "elvauations"
    // As an alloc is a mapping from a TaskGroup to a client, a "blocked alloc" due to resource contraints
    // is not possible. Rather it appears int he Nomad API as a "blocked evaluation"

    // So this function will let us know if there are any jobs that are requesting resources that the cluster does not have
    // and therefore cannot be placed.

    const evaluations = await getEvaluationsStatus()
    let totalBlockedMemory = 0
    let totalBlockedCPU = 0

    let maxBlockedMemory = 0
    let maxBlockedCPU = 0

    for (var evaluation of evaluations) {
        if (evaluation.Status != "blocked") {
            continue
        }
        var allocs = Object.keys(evaluation.FailedTGAllocs)

        for (var allocName of allocs) {
            let alloc = evaluation.FailedTGAllocs[allocName]
            let allocDatacenter = Object.keys(alloc.NodesAvailable)[0]
            if (allocDatacenter !== nomadDatacenter) {
                log.debug(`Excluding alloc ${allocName} as the datacenter is ${allocDatacenter}`)
                continue
            }
            let totalAllocResourceMemory = 0
            let totalAllocResourcesCPU = 0
            if (alloc.ResourcesExhausted) {
                var tasks = Object.keys(alloc.ResourcesExhausted)
                for (var taskName of tasks) {
                    let task = alloc.ResourcesExhausted[taskName]
                    totalAllocResourceMemory += task.MemoryMB
                    totalAllocResourcesCPU += task.CPU
                }
                let numAllocs = await getNumberOfQueuedAllocsByJobAndAllocName(evaluation.JobID, allocName)
                let resources = await getTotalResourceOfAllocInJob(evaluation.JobID, allocName)

                var perAllocResourceMemory = resources.allocMemLimit
                var perAllocResourceCPU = resources.allocCpuLimit
                if (perAllocResourceMemory > maxBlockedMemory) {
                    maxBlockedMemory = perAllocResourceMemory
                }

                if (perAllocResourceCPU > maxBlockedCPU) {
                    maxBlockedCPU = perAllocResourceCPU
                }
                totalBlockedMemory += resources.allocMemLimit * numAllocs
                totalBlockedCPU += resources.allocCpuLimit * numAllocs
            }

        }


    }

    return {
        totalBlockedMemory,
        totalBlockedCPU,
        maxBlockedMemory,
        maxBlockedCPU
    }
}

async function getRandomNodeName() {
    let nodes = await getFilteredNodes()
    let nodeName = nodes[0].Name
    log.debug(`Found random node name of ${nodeName}`)
    return nodeName
}

// async function drainAndWait(nodeId) {
//     var nodeInfo = await getNodeById(nodeId)
//     log.info(`Draining node ${nodeId} with UUID ${nodeInfo.ID}`)
//     var drainSpec = {
//         DrainSpec: {
//             Deadline: 0,
//             IgnoreSystemJobs: false
//         },
//         Meta: {
//             message: "Autoscaler scaled down"
//         }
//     }

//     var response = await queryNomadApi(`/v1/node/${nodeInfo.ID}/drain`, drainSpec, true)
//     log.debug(`Set Node ID ${nodeId} to drain`)
//     await wait(5000); // Wait for 5 seconds
//     let node = await queryNomadApi(`/v1/node/${nodeInfo.ID}`, false, true);
//     while (node.LastDrain.Status != 'complete') {
//         await wait(10000); // Wait for 10 seconds
//         log.debug(`Waiting for node ID ${nodeId} to drain`)
//         node = await queryNomadApi(`/v1/node/${nodeInfo.ID}`, false, true);
//     }
// }

export {
    getDatacenterUtilization,
    getTotalMemoryAndCPUUsage,
    getTotalNodeMemoryAndCPU,
    getBlockedResourceRequirements,
    determineScaleDownNode,
    getRandomNodeName
}