# Keep isolated internal processes inside one product App

Yulu ships one user-visible `/Applications/Yulu.app` while keeping the product
shell, bundled Host, and Capture helper as separately signed and restartable
processes inside that App. The Capture helper retains the existing
`com.yulu.audiodaemon` identity and signing team to preserve the best available
microphone-permission continuity; this structure keeps crash and entitlement
boundaries while users install and manage only one product App.
