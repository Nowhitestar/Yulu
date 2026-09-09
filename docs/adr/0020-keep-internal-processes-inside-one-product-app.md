# Keep isolated internal processes inside one product App

Yulu ships one user-visible `/Applications/Yulu.app` while keeping the product
shell, bundled Host, and Capture helper as separately signed and restartable
processes inside that App. The Capture helper retains the existing
`com.yulu.audiodaemon` identity and signing team to preserve the best available
microphone-permission continuity; this structure keeps crash and entitlement
boundaries while users install and manage only one product App.

Keeping that helper identity does not guarantee it is the TCC authorization
subject. Installed-App acceptance showed macOS attributing the bundled Capture
service's microphone and system-audio requests to the containing `com.yulu.app`.
The product App must therefore also declare the capture usage descriptions and
the hardened-runtime audio-input entitlement; declarations only on Capture are
insufficient. Both signed executables and both bundles' usage descriptions are
checked by Application Runtime verification, before inventory creation and again
after final signing. This permits the normal macOS authorization flow, not an
implicit permission grant or evidence that recorded audio contains a signal.

The RC15 acceptance run saved all-zero audio while TCC denied microphone access
for the missing product entitlement and refused system-audio authorization for
the missing product usage description. Its failed recording remains failed.
Corrected package checks do not replace fresh permission and production-recording
acceptance of a new signed build under #170.
