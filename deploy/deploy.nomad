job "nomad-swiftscale" {

  type        = "service"
  priority    = 70

  group "autoscaler" {
    count = 1

    task "autoscaler" {
      driver = "docker"

      config {
        image   = "megalan247/nomad-swiftscale:latest"
      }

    env {
      NOMAD_ADDR="http://nomad.service.consul:4646"
    }

      resources {
        cpu    = 50
        memory = 128

      }

    }
  }
}