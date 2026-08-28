# Register background services with SMAppService

The Applications-distributed Yulu registers its bundled login and background
services through `SMAppService` and reports system approval separately from
registration. It does not install release-time executable paths into user
LaunchAgent plists, allowing the whole signed App to move and update as one unit.
