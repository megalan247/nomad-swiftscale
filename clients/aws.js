import AWS from 'aws-sdk';
import log from 'loglevel';
import fs from 'fs';
import got from 'got';
import { promisify } from 'util';
import * as nomad from './nomad.js'

const awsRegion = await getCurrentRegion()

const ec2 = new AWS.EC2({ region: awsRegion });
const autoscaling = new AWS.AutoScaling({ region: awsRegion });

const instanceTypes = JSON.parse(fs.readFileSync("ec2instances.json"))

const wait = promisify(setTimeout);

async function getCurrentRegion() {
  try {
    const response = await got('http://169.254.169.254/latest/meta-data/placement/availability-zone');
    log.debug(`Got response form availability zone endpoint: ${response.body}`)
    const availabilityZone = response.body;
    const region = availabilityZone.slice(0, -1);
    return region;
  } catch (error) {
    // If not running in AWS, return 'eu-central-1'
    log.error(error)
    return 'eu-central-1';
    
  }
}

async function getAsgFromInstanceId(instanceId) {
  try {
    log.debug(`Trying to find ASG and LT for node ID ${instanceId}`)
    const params = {
      InstanceIds: [instanceId],
    };

    const { Reservations } = await ec2.describeInstances(params).promise();
    const instance = Reservations[0].Instances[0];
    const autoScalingGroupName = instance.Tags.find((tag) => tag.Key === 'aws:autoscaling:groupName').Value;
    log.debug(`Found ASG name ${autoScalingGroupName}`);
    const autoScalingParams = {
      AutoScalingGroupNames: [autoScalingGroupName],
    };

    var { AutoScalingGroups } = await autoscaling.describeAutoScalingGroups(autoScalingParams).promise();
    var firstAsg = AutoScalingGroups[0]
    // If the instance chosen has a MixedInstancesPolicy, the LaunchTemplate is in a different place in the AWS API Response
    // So we "Fake" the old API reponse here to be consistant for upstream function calls
    if (firstAsg.MixedInstancesPolicy) {
      var launchTemplate = firstAsg.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification.LaunchTemplateName;
      firstAsg.LaunchTemplate = firstAsg.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification
    } else {
      var launchTemplate = firstAsg.LaunchTemplate;
    }

    
    log.debug(`Found ASG ${JSON.stringify(AutoScalingGroups)} and LT ${JSON.stringify(launchTemplate)} associated with node ID ${instanceId}`)

    return firstAsg;
  } catch (error) {
    log.error('Error fetching ASG and Launch Template:' + error);
    throw error;
  }
}

// async function getInstancesWithTags(tagKey, tagValue) {
//   const filters = [
//     {
//       Name: `tag:${tagKey}`,
//       Values: [tagValue],
//     },
//     {
//       Name: 'instance-state-name',
//       Values: ['running'],
//     },
//   ];

//   const params = {
//     Filters: filters,
//   };

//   const result = await ec2.describeInstances(params).promise();
//   return result.Reservations.map(reservation =>
//     reservation.Instances.map(instance => ({
//       id: instance.InstanceId,
//       type: instance.InstanceType,
//       tags: instance.Tags,
//       resourceUsage: instance.CpuOptions
//     }))
//   ).flat();
// }

async function createAutoScalingGroup(groupName, instanceTypeOverride) {

  // Get the tags and VPCZoneIdentifier for the source Auto Scaling group
  const randomNodeName = await nomad.getRandomNodeName();
  const sourceAutoScalingGroup = await getAsgFromInstanceId(randomNodeName.slice(2));
  const launchTemplateName = sourceAutoScalingGroup.LaunchTemplate.LaunchTemplateName;

  const sourceTags = sourceAutoScalingGroup.Tags.map(tag => {
    return {
      Key: tag.Key,
      Value: tag.Value,
      PropagateAtLaunch: true
    };
  });
  const sourceVPCZoneIdentifier = sourceAutoScalingGroup.VPCZoneIdentifier;


  const params = {
    AutoScalingGroupName: groupName,
    MaxSize: 2,
    MinSize: 0,
    DesiredCapacity: 1,
    VPCZoneIdentifier: sourceVPCZoneIdentifier,
    Tags: sourceTags,
    MixedInstancesPolicy: {
      LaunchTemplate: {
        LaunchTemplateSpecification: {
          LaunchTemplateName: launchTemplateName,
          Version: "$Latest"
        },
        Overrides: [
          {
            InstanceType: instanceTypeOverride
          }
        ]
      }
    },
  };

  try {
    const result = await autoscaling.createAutoScalingGroup(params).promise();
    log.info(`Auto Scaling group ${groupName} created with launch configuration ${launchTemplateName} and instance type override ${instanceTypeOverride}.`);
    log.debug(result);
  } catch (err) {
    log.error(`Error creating Auto Scaling group ${groupName}.`);
    log.error(err);
  }
};

async function deleteAutoScalingGroupByInstanceId(instanceId) {

  const instance = await ec2.describeInstances({ InstanceIds: [instanceId] }).promise();

  const autoScalingGroupNames = instance.Reservations[0].Instances[0].Tags.filter((tag) => {
    return tag.Key === 'aws:autoscaling:groupName';
  }).map((tag) => {
    return tag.Value;
  });

  if (autoScalingGroupNames.length === 0) {
    log.error(`Instance ${instanceId} is not associated with any Auto Scaling group.`);
    return;
  }

  for (const autoScalingGroupName of autoScalingGroupNames) {
    try {
      if (autoScalingGroupName.startsWith("nm-auto")) {
        log.info(`Instance ID ${instanceId} is associated with the ASG ${autoScalingGroupName} which is managed by the autoscaler. Deleting the ASG`)
        await autoscaling.deleteAutoScalingGroup({ AutoScalingGroupName: autoScalingGroupName, ForceDelete: true }).promise();
        log.info(`Auto Scaling group ${autoScalingGroupName} deleted.`);
      } else {
        log.info(`Instance ${instanceId} is not associated with an autoscaler-managed asg. Terminating the instance without deleting the asg`)
        await terminateInstance(instanceId)
      }

    } catch (err) {
      log.error(`Error deleting Auto Scaling group ${autoScalingGroupName}.`);
      log.error(err);
    }
  }
};

async function terminateInstance(instanceId) {
  const params = {
    InstanceIds: [instanceId],
  };

  const data = await ec2.describeInstances(params).promise();

  if (data.Reservations.length > 0) {
    const terminateParams = {
      InstanceId: instanceId,
      ShouldDecrementDesiredCapacity: true,
    };

    const terminateData = await autoscaling.terminateInstanceInAutoScalingGroup(terminateParams).promise();
    log.info(`Terminating instance ${instanceId}`);
    await ec2.waitFor('instanceTerminated', { InstanceIds: [instanceId] }).promise();
    log.info(`Instance ${instanceId} terminated successfully.`)
    return true;
  } else {
    log.warn(`No running or stopped instances found with the name ${instanceName}`);
    return false;
  }
}


function getLeastExpensiveCombination(jobs) {

    let instances = instanceTypes
    // Convert job CPU to num_cpus
    jobs = jobs.map(job => ({ cpu: job.cpu / 2000, mem: job.mem }));
  
    // Sort instances by hourly price in ascending order, then by memory_mb in descending order
    instances.sort((a, b) => a.hourly_price - b.hourly_price || b.memory_mb - a.memory_mb);
  
    let totalCost = 0;
    let activeInstances = [];

    for (let job of jobs) {
        let placed = false;

        // Try to place the job on an active instance
        for(let i = 0; i < activeInstances.length; i++) {
            let instance = activeInstances[i];
            if(job.cpu <= instance.remainingCpu && job.mem <= instance.remainingMem) {
                instance.remainingCpu -= job.cpu;
                instance.remainingMem -= job.mem;
                placed = true;
                break;
            }
        }

        // If not placed, select a new instance
        if(!placed) {
            for(let instance of instances) {
                if(job.cpu <= instance.num_cpus && job.mem <= instance.memory_mb) {
                    activeInstances.push({ 
                        type: instance.type, 
                        hourlyPrice: instance.hourly_price, 
                        remainingCpu: instance.num_cpus - job.cpu, 
                        remainingMem: instance.memory_mb - job.mem 
                    });
                    totalCost += instance.hourly_price;
                    placed = true;
                    break;
                }
            }
        }

        if(!placed) {
            console.log(`Cannot place job with cpu: ${job.cpu}, mem: ${job.mem}`);
        }
    }
  
    return { allocations: activeInstances.map(i => ({ instanceType: i.type, hourlyPrice: i.hourlyPrice })), totalCost };
}

async function refreshManagedAutoScalingGroups() {
  log.debug(`Checking if there are any managed ASGs with new launch template version to update`)
  const params = {
    AutoScalingGroupNames: [],  // Use empty array to get all ASG
  };

  const asgResponse = await autoscaling.describeAutoScalingGroups(params).promise();
  log.debug(`Found ${asgResponse.AutoScalingGroups.length} groups in total`)
  for (const group of asgResponse.AutoScalingGroups) {
    // Check for ASG name pattern
    if (group.AutoScalingGroupName.includes('nm-auto')) {
      log.debug(`Found ${group.AutoScalingGroupName} as a managed AWS ASG`)
      const launchTemplate = group.MixedInstancesPolicy.LaunchTemplate.LaunchTemplateSpecification;

      // Get launch template versions
      const ltParams = {
        LaunchTemplateName: launchTemplate.LaunchTemplateName,
      };

      const ltResponse = await ec2.describeLaunchTemplateVersions(ltParams).promise();
      const latestVersionNumber = ltResponse.LaunchTemplateVersions[0].VersionNumber;

      let currentInstanceVersion = await checkInstancesVersion(group.AutoScalingGroupName, latestVersionNumber)

      // Check if there's a new launch template version
      if (currentInstanceVersion) {
        log.info(`ASG ${group.AutoScalingGroupName} currently has launch template version ${currentInstanceVersion} however the latest version is ${String(latestVersionNumber)}. Will update...`)
        const updateParams = {
          AutoScalingGroupName: group.AutoScalingGroupName,
          MaxSize: 2
        };
        log.debug(`Updating ASG with params ${JSON.stringify(updateParams)}`)
        // Update ASG with the new launch template version
        await autoscaling.updateAutoScalingGroup(updateParams).promise();

        // Start a new instance
        const setDesiredCapacityParams = {
          AutoScalingGroupName: group.AutoScalingGroupName,
          DesiredCapacity: group.DesiredCapacity + 1  // Add one to the desired capacity
        };
        log.debug(`Setting new desired capacity using params ${JSON.stringify(setDesiredCapacityParams)} and waiting 2 minutes to scale out`)
        // Add a new instance to the ASG and wait for it to become healthy
        await autoscaling.setDesiredCapacity(setDesiredCapacityParams).promise();
        await wait(120000);  // Wait for 2 minutes. You may need to adjust the waiting time.
      
        // Now reduce back the desired capacity which will remove the oldest instance
        setDesiredCapacityParams.DesiredCapacity -= 1;
        log.debug(`Waiting 2 minutes after scaling in instance by setting desired capacity down to 1 using params ${JSON.stringify(setDesiredCapacityParams)}`);
        await autoscaling.setDesiredCapacity(setDesiredCapacityParams).promise();
        await wait(120000);
        log.debug(`ASG ${group.AutoScalingGroupName} updated!`)
      }
    }
  }
}

async function checkInstancesVersion(asgName, desiredLtVersion) {
  log.debug(`Checking ASG ${asgName} to see if any instances do not have LT version ${desiredLtVersion}`)
  const describeAsgParams = {
    AutoScalingGroupNames: [asgName],
  };

  const asgResponse = await autoscaling.describeAutoScalingGroups(describeAsgParams).promise();
  const instances = asgResponse.AutoScalingGroups[0].Instances;
  
  for (const instance of instances) {
    log.debug(`Checking instance ${instance.InstanceId}`)
    const describeInstancesParams = {
      InstanceIds: [instance.InstanceId],
    };

    const instanceResponse = await ec2.describeInstances(describeInstancesParams).promise();
    log.debug(`Received response from AWS ${JSON.stringify(instanceResponse)}`)
    const instanceLtVersion = getLaunchTemplateVersionFromTagsArray(instanceResponse.Reservations[0].Instances[0].Tags);

    if (instanceLtVersion !== String(desiredLtVersion)) {
      log.debug(`Instance ${instance.InstanceId} has LT version ${instanceLtVersion} which is different from desired version ${String(desiredLtVersion)}. Returning true`)
      return instanceLtVersion;
    }
  }

  return false;
}

function getLaunchTemplateVersionFromTagsArray(tagsArray) {
  let tags = tagsArray.find(tag => tag.Key === "aws:ec2launchtemplate:version");
  return tags.Value || false
}

export {
  terminateInstance,
  createAutoScalingGroup,
  getLeastExpensiveCombination,
  deleteAutoScalingGroupByInstanceId,
  refreshManagedAutoScalingGroups
};