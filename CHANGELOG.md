# Changelog

## v1.0.1-dev3

- Fix mobile navigation overlapping the player sidebar, oversized player settings rows and playlist editor labels colliding with timing controls.
- Add browser geometry checks for navigation, settings and image/video playlist rows at phone, tablet and desktop sizes. No new runtime dependencies.

## v1.0.1-dev2

Player screen orientation; responsive phone/tablet layouts; authenticated server-generated video thumbnails; refresh feedback and preview retry; explicit disabled Already enrolled scan results.


## 1.0.1-dev1

- Open the next development cycle from v1.0.0 GOLDEN.
- Runtime behavior is unchanged; only development version/channel labels differ.

## 1.0.0 GOLDEN

- Promote owner-approved DEV4 to the stable main branch.
- Translate installer, bootstrap and primary documentation into English; preserve the bilingual web interface.
- Publish stable and development assets through one tested release workflow.
- Document hardware acceptance and preserve the original local Chrome GOLDEN.

## 0.1.0-dev4

- Require a password for new/restored tabs while retaining sessions on refresh.
- Add panel/wizard Logout with server-side session revocation.
- Add SHA-256 verified curl bootstrap, temporary download cleanup and offline local menu.
- Establish develop prereleases and a separate stable main branch.

## 0.1.0-dev3

- Order router setup: generate, copy/download, import/connect, check, open router.
- Add authenticated native player GUIs on persistent HTTPS ports 8444–8543, with atomic mapping updates and revocation.
- Add Access player to Info and Settings.
- Allow confirmed manual deletion of Home/Event media, including live files; retain automatic cleanup protections.
- Improve installer/removal stages, final URLs and saved setup details.
