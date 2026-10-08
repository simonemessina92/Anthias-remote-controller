# Source baseline

The VPS project started from the local **Anthias Rooms v1.0.0 GOLDEN** Chrome extension. Its approved source archive is `Anthias_Rooms_v1.0.0_GOLDEN.zip`.

SHA-256: `4f8a36720e30f1389f026ea7ca5b4066e2b74d45303aa228ca5045794ef50192`.

The VPS installer does not update, remove or overwrite the local extension. Historical storage key suffixes are preserved. The VPS adapter provides server-backed storage and remote locks; the operator browser requires no Chrome APIs. The Chrome background shell and manifest are not installed on the VPS.

## Stable release history

VPS **v1.0.0 GOLDEN** promoted approved DEV4 commit `e76198710f71fdc9e990f24da8e5bb4b8f86845c`. Promotion updated version labels, CLI language, documentation and release automation while retaining the approved runtime behavior. Extended manual deletion is implemented in `manual-delete.js`, separately from the original automatic cleanup protections.

VPS **v1.0.1 GOLDEN** retains the tested v1.0.1-dev5 runtime from commit `3d99fa32d468ece3b2aa3585df66f191e248eb22`, with stable version labels and updated documentation. The `main` branch and stable release remain at commit `9afb63e7605d18c0425812bfdf263f8d2b835fe3`.

## Shared-controller development

VPS **v1.0.2-dev1** adds `web/player-state.js` and updates panel, storage and translation code to share Home/Event assignments with **Chrome v3.1.0-dev2**. These files are no longer byte-identical to the original extension baseline. Configuration migration acquires the existing configuration lock, and shared revisions invalidate stale editors and cleanup jobs.

The published VPS package uses commit `6bf16c5ef074f41cfb6df6085675ba04cefc4cd6`; its integration test pins the Chrome extension to commit `76ad9e71a97b538a5621e579dba0b56308a93777`. Both releases are prereleases. Automated verification is complete; physical-player acceptance is pending.

Published release assets remain unchanged when repository documentation is corrected. The release tag identifies the exact packaged source.
