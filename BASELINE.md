# Source baseline

This VPS project is separate from the original local **Anthias Rooms v1.0.0 GOLDEN** Chrome extension. Its approved source archive is `Anthias_Rooms_v1.0.0_GOLDEN.zip`.

SHA-256: `4f8a36720e30f1389f026ea7ca5b4066e2b74d45303aa228ca5045794ef50192`.

The VPS installer does not update, remove or overwrite the local GOLDEN. `logic.js`, `lifecycle.js`, `storage.js`, `discovery.js`, `editor-state.js`, `media-library.js` and icons are byte-identical to that baseline. Historical storage key suffixes are preserved. The VPS adapter provides shared storage and remote locks; the operator browser requires no Chrome APIs. The Chrome background shell and manifest are not installed on the VPS.

The VPS **v1.0.0 GOLDEN** promotes owner-approved DEV4 commit `e76198710f71fdc9e990f24da8e5bb4b8f86845c`. Promotion changes version labels, CLI language, documentation and release automation; the approved runtime behavior is retained. Extended manual deletion is implemented in `manual-delete.js`, separately from the original automatic cleanup protections.

The VPS v1.0.1 GOLDEN retains the tested v1.0.1-dev5 runtime from commit `3d99fa32d468ece3b2aa3585df66f191e248eb22`, with stable version labels and updated documentation.
