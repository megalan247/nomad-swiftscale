
<a name="readme-top"></a>


<br />
<div align="center">

<h3 align="center">Nomad Swiftscale</h3>

  <p align="center">
    Nomad Switftscale is a Hashicorp Nomad Cluster Autoscaler, designed to make smart autoscaling decisions in AWS.
    <br />
    <br />
    <a href="https://github.com/megalan247/nomad-swiftscale/issues">Report Bug</a>
    ·
    <a href="https://github.com/megalan247/nomad-swiftscale/issues">Request Feature</a>
  </p>
</div>

<!-- ABOUT THE PROJECT -->
## About The Project

Automatically scaling your Hashicorp Nomad cluster to be the correct size can become quite complex in certain environments, especially when you have many different jobs with different resource requirements. 

Nomad Swiftscale has many advantages over other solutions, including:

- **Ability to scale using different instance types**  
Other autoscalers may use a simple metric to determine the desired count of an AWS Autoscaling Group. Nomad Swiftscale will understand what resources are required, and add an appropriately sized instance to the cluster.
- **Scales based on Job Priority (will scale down nodes that have lower priority jobs first)**  
Sometimes in a cluster, you have certain jobs that are more important than others, and some jobs you can't have be reallocated at all. Nomad Swiftscale understands Nomad Job Priority to only scale down nodes with lower priority jobs first.
- **Upscaling based on blocked resources**  
Nomad Swiftscale queries the Nomad API to determine the amount of blocked resources, and understands placement of these blocked resources on an allocation-level.
- **Automatically determine the most cost-effective upscale decision**  
Nomad Swiftscale understands the instance types available in AWS, and will scale an appropriate size. If you only want to use certain instance types, you can also specify that.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## How It Works

Swiftscale has fundamentally two functions:

### Scaling Up
Swiftscale will only scale up on blocked resources. It does not check for any percentage of usage and use this as a metric to scale up on, if Nomad cannot place an allocation, Swiftscale will scale up enough to place that allocation.

It will check what the minimum required about of CPU and RAM is for each allocation, and then compare the resource requirements with a list of EC2 Instance types as specified in `ec2instances.json`. Then it will determine the lowest cost option to scale up, and create appropriate autoscaling groups with the same configuration as a "base" autoscaling group.

### Scaling Down
If the overall cluster utilization is below 90% of either memory or CPU, Swiftscale will try to scale the cluster down. It will do this by performing the below steps:

1. It will first get a list of all Nodes in the cluster assigned to a specific datacenter
2. Next, it will order these nodes based on utilization, with the least-utilized nodes being the first
3. Then it will check each job on each node for the job with the highest priority, and move the highest priority nodes to the end of the list. There is also a cutoff where it will never scale down nodes with a priority above a configurable value.
4. It will then pick the first node from this list, and check if the node can be drained. If the node cannot be drained it will try the next node.
5. If the node can be drained, it will delete the associated autoscaling group if it is managed by Swiftscale, or terminate the instance using the `terminateInstanceInAutoScalingGroup` call.

<!-- GETTING STARTED -->
## Getting Started

A prebuilt Docker container is available from Dockerhub, containing the autoscaler. You can pull the image by simply running

```
docker pull megalan247/nomad-swiftscale:latest
```

An example Nomad Job for the autoscaler is available at `nomad/deploy.nomad`.

## Required Permissions

When running in AWS, the required permissions are quite broad, owing to the function of the autoscaler. Therefore we would normally recommend adding the below AWS Managed Permission Sets to your instance IAM role

- `AmazonEC2FullAccess`
- `AutoScalingFullAccess`
- `AWSResourceGroupsReadOnlyAccess`

If you assign an IAM role as part of the AWS Autoscaling group you want to scale with Swiftscale, you will also need to allow the autoscaler to `PassRole` the appropriate IAM role, in order to create new Autoscaling groups.

<!-- ROADMAP -->
## Roadmap

- [ ] Create Reconciliation function, to periodically change all instance types int he cluster to be more efficient
- [ ] Add metrics for monitoring
- [ ] Refactor some elements to be more efficient 
    - [ ] getLeastExpensiveCombination
    - [ ] getBlockedResourceRequirements

See the [open issues](https://github.com/github_username/repo_name/issues) for a full list of proposed features (and known issues).

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>



<!-- LICENSE -->
## License

Distributed under the GPLv3 License. See `LICENSE` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
