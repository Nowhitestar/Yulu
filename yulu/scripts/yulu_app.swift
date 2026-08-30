import Cocoa
import Darwin
import ServiceManagement
import WebKit

struct LaunchPolicy: Encodable {
    static let installedBundlePath = "/Applications/Yulu.app"

    let installed: Bool
    let persistentRegistrationAllowed: Bool
    let componentsStarted: Bool
    let guidance: String?

    enum CodingKeys: String, CodingKey {
        case installed, persistentRegistrationAllowed, componentsStarted, guidance
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(installed, forKey: .installed)
        try container.encode(persistentRegistrationAllowed, forKey: .persistentRegistrationAllowed)
        try container.encode(componentsStarted, forKey: .componentsStarted)
        if let guidance {
            try container.encode(guidance, forKey: .guidance)
        } else {
            try container.encodeNil(forKey: .guidance)
        }
    }

    static func evaluate(bundlePath: String) -> LaunchPolicy {
        let resolved = URL(fileURLWithPath: bundlePath)
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
        let installed = resolved == installedBundlePath
        return LaunchPolicy(
            installed: installed,
            persistentRegistrationAllowed: installed,
            componentsStarted: installed,
            guidance: installed ? nil : "Drag Yulu to Applications before opening it."
        )
    }
}

struct BackgroundServiceDescriptor {
    let plistName: String

    static let bundledOwners = [
        BackgroundServiceDescriptor(plistName: "com.yulu.ui.plist"),
        BackgroundServiceDescriptor(plistName: "com.yulu.audiodaemon.plist"),
    ]
}

struct ProductionStartupPlan: Encodable {
    let persistentRegistrations: [String]
    let directChildren: [String] = []
    let hostHealthURL: String?

    enum CodingKeys: String, CodingKey {
        case persistentRegistrations, directChildren, hostHealthURL
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(persistentRegistrations, forKey: .persistentRegistrations)
        try container.encode(directChildren, forKey: .directChildren)
        if let hostHealthURL {
            try container.encode(hostHealthURL, forKey: .hostHealthURL)
        } else {
            try container.encodeNil(forKey: .hostHealthURL)
        }
    }

    static func make(policy: LaunchPolicy) -> ProductionStartupPlan {
        ProductionStartupPlan(
            persistentRegistrations: policy.persistentRegistrationAllowed
                ? BackgroundServiceDescriptor.bundledOwners.map(\.plistName)
                : [],
            hostHealthURL: policy.installed
                ? "http://127.0.0.1:\(HostServiceExecution.declaredPort)/healthz"
                : nil
        )
    }
}

protocol PersistentServiceRegistering {
    func register(_ service: BackgroundServiceDescriptor)
}

struct BackgroundServiceOwnership {
    static func registerBundledOwners(
        policy: LaunchPolicy,
        registrar: PersistentServiceRegistering
    ) {
        guard policy.persistentRegistrationAllowed else { return }
        for service in BackgroundServiceDescriptor.bundledOwners {
            registrar.register(service)
        }
    }
}

struct ServiceRegistrationDecision: Encodable {
    let register: Bool
    let unregister = false

    static func make(policy: LaunchPolicy, status: String) -> ServiceRegistrationDecision? {
        guard ["notRegistered", "enabled", "requiresApproval", "notFound"].contains(status) else {
            return nil
        }
        return ServiceRegistrationDecision(
            register: policy.persistentRegistrationAllowed && status == "notRegistered"
        )
    }
}

final class ServiceActionRecorder: PersistentServiceRegistering, Encodable {
    private(set) var register: [String] = []
    let unregister: [String] = []
    let persistentFileWrites: [String] = []

    func register(_ service: BackgroundServiceDescriptor) {
        register.append(service.plistName)
    }
}

enum RegistrationEvidence: String, Encodable {
    case notRegistered = "not_registered"
    case registered
    case notFound = "not_found"
}

enum SystemApprovalEvidence: String, Encodable {
    case unknown
    case requiresApproval = "requires_approval"
    case approved
}

enum RunningHealth: String, Encodable {
    case unknown
    case stopped
    case healthy
}

enum CapabilityReadiness: String, Encodable {
    case unknown
    case blocked
    case ready
}

struct BackgroundServiceState: Encodable {
    let registration: RegistrationEvidence
    let systemApproval: SystemApprovalEvidence
    let runningHealth: RunningHealth
    let capabilityReadiness: CapabilityReadiness

    static func evaluate(status: String, running: String, ready: String) -> BackgroundServiceState? {
        let registration: RegistrationEvidence
        let approval: SystemApprovalEvidence
        switch status {
        case "notRegistered":
            registration = .notRegistered
            approval = .unknown
        case "requiresApproval":
            registration = .registered
            approval = .requiresApproval
        case "enabled":
            registration = .registered
            approval = .approved
        case "notFound":
            registration = .notFound
            approval = .unknown
        default:
            return nil
        }

        func signal<T>(_ raw: String, unknown: T, negative: T, positive: T) -> T? {
            switch raw {
            case "unknown": unknown
            case "false": negative
            case "true": positive
            default: nil
            }
        }
        guard let runningHealth = signal(
            running,
            unknown: RunningHealth.unknown,
            negative: .stopped,
            positive: .healthy
        ), let capabilityReadiness = signal(
            ready,
            unknown: CapabilityReadiness.unknown,
            negative: .blocked,
            positive: .ready
        ) else { return nil }
        return BackgroundServiceState(
            registration: registration,
            systemApproval: approval,
            runningHealth: runningHealth,
            capabilityReadiness: capabilityReadiness
        )
    }
}

struct ApprovalRemediation: Encodable {
    let action = "open_login_items_settings"
    let path = "System Settings → General → Login Items → Allow in the Background"
    let resumeOn = "applicationDidBecomeActive"
}

struct ServiceStateRow: Encodable {
    let label: String
    let value: String
}

struct BackgroundServicePresentation: Encodable {
    let title = "Background Services"
    let rows: [ServiceStateRow]
    let remediation: ApprovalRemediation?

    static func make(state: BackgroundServiceState) -> BackgroundServicePresentation {
        func title<T: RawRepresentable>(_ value: T) -> String where T.RawValue == String {
            let normalized = value.rawValue.replacingOccurrences(of: "_", with: " ")
            return normalized.prefix(1).uppercased() + normalized.dropFirst()
        }
        return BackgroundServicePresentation(
            rows: [
                ServiceStateRow(label: "Registration", value: title(state.registration)),
                ServiceStateRow(label: "System approval", value: title(state.systemApproval)),
                ServiceStateRow(label: "Running health", value: title(state.runningHealth)),
                ServiceStateRow(label: "Capability readiness", value: title(state.capabilityReadiness)),
            ],
            remediation: state.systemApproval == .requiresApproval ? ApprovalRemediation() : nil
        )
    }
}

struct OwnerServicePresentation: Encodable {
    let label: String
    let state: BackgroundServicePresentation
}

struct BundledServicesPresentation: Encodable {
    let services: [OwnerServicePresentation]

    static func make(host: BackgroundServiceState, capture: BackgroundServiceState) -> BundledServicesPresentation {
        BundledServicesPresentation(services: [
            OwnerServicePresentation(
                label: "Host — com.yulu.ui",
                state: BackgroundServicePresentation.make(state: host)
            ),
            OwnerServicePresentation(
                label: "Capture — com.yulu.audiodaemon",
                state: BackgroundServicePresentation.make(state: capture)
            ),
        ])
    }
}

struct RuntimeOwnerEvidence: Encodable {
    let running: Bool
    let capabilityReady: Bool?
    let ownerPID: Int?

    enum CodingKeys: String, CodingKey {
        case running, capabilityReady, ownerPID
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(running, forKey: .running)
        if let capabilityReady {
            try container.encode(capabilityReady, forKey: .capabilityReady)
        } else {
            try container.encodeNil(forKey: .capabilityReady)
        }
        if let ownerPID {
            try container.encode(ownerPID, forKey: .ownerPID)
        } else {
            try container.encodeNil(forKey: .ownerPID)
        }
    }

    static func evaluate(
        kind: String,
        payload: [String: Any],
        attestation: RuntimeOwnerAttestation
    ) -> RuntimeOwnerEvidence? {
        let expectedOwner: String
        switch kind {
        case "host": expectedOwner = "com.yulu.ui"
        case "capture": expectedOwner = "com.yulu.audiodaemon"
        default: return nil
        }
        guard payload["serviceOwner"] as? String == expectedOwner,
              let pid = payload["pid"] as? Int,
              pid > 1,
              pid == attestation.ownerPID,
              attestation.executableMatches,
              attestation.argumentsMatch,
              attestation.generationStable,
              let processGeneration = attestation.generation,
              !processGeneration.isEmpty else {
            return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
        }
        if kind == "host" {
            guard let authorityToken = attestation.authorityToken,
                  !authorityToken.isEmpty,
                  payload["instanceLockToken"] as? String == authorityToken else {
                return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
            }
            let healthy = payload["status"] as? String == "ok"
            return RuntimeOwnerEvidence(
                running: healthy,
                capabilityReady: nil,
                ownerPID: healthy ? pid : nil
            )
        }
        return RuntimeOwnerEvidence(
            running: true,
            capabilityReady: payload["micReady"] as? Bool == true
                && payload["sysReady"] as? Bool == true,
            ownerPID: pid
        )
    }
}

struct RuntimeOwnerAttestation: Encodable {
    let ownerPID: Int
    let authorityToken: String?
    let generation: String?
    let executableMatches: Bool
    let argumentsMatch: Bool
    let generationStable: Bool

    static func decode(_ payload: [String: Any]) -> RuntimeOwnerAttestation? {
        guard let ownerPID = payload["ownerPID"] as? Int,
              ownerPID > 1,
              let executableMatches = payload["executableMatches"] as? Bool,
              let argumentsMatch = payload["argumentsMatch"] as? Bool,
              let generationStable = payload["generationStable"] as? Bool else {
            return nil
        }
        return RuntimeOwnerAttestation(
            ownerPID: ownerPID,
            authorityToken: payload["authorityToken"] as? String,
            generation: payload["generation"] as? String,
            executableMatches: executableMatches,
            argumentsMatch: argumentsMatch,
            generationStable: generationStable
        )
    }
}

func appServiceStatusName(_ status: SMAppService.Status) -> String {
    switch status {
    case .notRegistered: "notRegistered"
    case .enabled: "enabled"
    case .requiresApproval: "requiresApproval"
    case .notFound: "notFound"
    @unknown default: "notFound"
    }
}

final class BackgroundServiceRegistry {
    private(set) var registrationErrors: [String: String] = [:]

    func registerBundledOwners(policy: LaunchPolicy) {
        guard policy.persistentRegistrationAllowed else { return }
        for descriptor in BackgroundServiceDescriptor.bundledOwners {
            let service = SMAppService.agent(plistName: descriptor.plistName)
            guard service.status == .notRegistered else { continue }
            do {
                try service.register()
                registrationErrors.removeValue(forKey: descriptor.plistName)
            } catch {
                registrationErrors[descriptor.plistName] = error.localizedDescription
            }
        }
    }

    func statuses() -> [String: String] {
        Dictionary(uniqueKeysWithValues: BackgroundServiceDescriptor.bundledOwners.map { descriptor in
            let service = SMAppService.agent(plistName: descriptor.plistName)
            return (descriptor.plistName, appServiceStatusName(service.status))
        })
    }
}

struct BundleLayout {
    let bundleURL: URL

    var hostNode: URL {
        bundleURL.appendingPathComponent("Contents/Resources/runtime/bin/node")
    }

    var hostEntry: URL {
        bundleURL.appendingPathComponent("Contents/Resources/Host/server.js")
    }

    var hostWeb: URL {
        bundleURL.appendingPathComponent("Contents/Resources/Host/web", isDirectory: true)
    }

    var bundledScriptDir: URL {
        bundleURL.appendingPathComponent("Contents/Resources/runtime/yulu/scripts", isDirectory: true)
    }

    var executableDir: URL {
        bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
    }

    var bundledPython: URL {
        bundleURL.appendingPathComponent("Contents/Resources/runtime/python/bin/python3")
    }

    var bundledPythonBin: URL {
        bundledPython.deletingLastPathComponent()
    }

    var bundledFFmpeg: URL {
        bundleURL.appendingPathComponent("Contents/Resources/runtime/bin/ffmpeg")
    }

    var bundledBin: URL {
        bundleURL.appendingPathComponent("Contents/Resources/runtime/bin", isDirectory: true)
    }

    var captureExecutable: URL {
        bundleURL.appendingPathComponent(
            "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"
        )
    }
}

struct ComponentContract: Encodable {
    let servicePlist: String
    let bundleProgram: String
    let arguments: [String]
    let directlySpawned = false
}

struct ShellContract: Encodable {
    let windowURL: String
    let menuRoutes: [String]
    let host: ComponentContract
    let capture: ComponentContract

    static func describe(bundleURL _: URL, port: Int = 7777) -> ShellContract {
        return ShellContract(
            windowURL: "http://127.0.0.1:\(port)/",
            menuRoutes: ["/", "/onboarding", "/inbox", "/settings"],
            host: ComponentContract(
                servicePlist: "com.yulu.ui.plist",
                bundleProgram: "Contents/MacOS/yulu_app",
                arguments: ["yulu_app", "--run-host-service"]
            ),
            capture: ComponentContract(
                servicePlist: "com.yulu.audiodaemon.plist",
                bundleProgram: "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
                arguments: ["audio_daemon"]
            )
        )
    }
}

struct BuildContract: Encodable {
    let developmentSmoke: Bool

    static var current: BuildContract {
        #if YULU_DEVELOPMENT_SMOKE
        BuildContract(developmentSmoke: true)
        #else
        BuildContract(developmentSmoke: false)
        #endif
    }
}

struct ApplicationDataPaths: Encodable {
    let durableDataDir: URL
    let configFile: URL
    let modelsDir: URL
    let cacheDir: URL
    let ipcDir: URL
    let logsDir: URL
    let mediaLibraryDir: URL
    let legacyReadOnlyDataDir: URL
    let configReadFiles: [URL]

    static func resolve(
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> ApplicationDataPaths {
        guard (homeDirectory.path as NSString).isAbsolutePath else {
            fatalError("Yulu application path home must be absolute")
        }
        let defaultDurable = homeDirectory.appendingPathComponent("Library/Application Support/Yulu", isDirectory: true)
        let defaultCache = homeDirectory.appendingPathComponent("Library/Caches/Yulu", isDirectory: true)
        let defaultLogs = homeDirectory.appendingPathComponent("Library/Logs/Yulu", isDirectory: true)
        let defaultMedia = homeDirectory.appendingPathComponent("Movies/Yulu", isDirectory: true)
        let defaultLegacy = homeDirectory.appendingPathComponent(".config/yulu", isDirectory: true)
        guard let defaultLegacyCanonical = canonical(defaultLegacy),
              let defaultMediaCanonical = canonical(defaultMedia) else {
            fatalError("unsafe Yulu standard path defaults")
        }
        let durableDataDir = chooseURL(
            "YULU_APPLICATION_SUPPORT_DIR",
            environment: environment,
            homeDirectory: homeDirectory,
            fallback: defaultDurable
        ) { candidate in
            !overlaps(candidate, defaultLegacyCanonical) && !overlaps(candidate, defaultMediaCanonical)
        }
        let durableCanonical = durableDataDir
        let cacheDir = chooseURL(
            "YULU_CACHE_DIR",
            environment: environment,
            homeDirectory: homeDirectory,
            fallback: defaultCache
        ) { candidate in
            !overlaps(candidate, durableCanonical)
                && !overlaps(candidate, defaultLegacyCanonical)
                && !overlaps(candidate, defaultMediaCanonical)
        }
        let cacheCanonical = cacheDir
        let logsDir = chooseURL(
            "YULU_LOG_DIR",
            environment: environment,
            homeDirectory: homeDirectory,
            fallback: defaultLogs
        ) { candidate in
            !overlaps(candidate, durableCanonical)
                && !overlaps(candidate, cacheCanonical)
                && !overlaps(candidate, defaultLegacyCanonical)
                && !overlaps(candidate, defaultMediaCanonical)
        }
        let logsCanonical = logsDir
        let modelsDir = chooseURL(
            "YULU_MODELS_DIR",
            environment: environment,
            homeDirectory: homeDirectory,
            fallback: durableDataDir.appendingPathComponent("Models", isDirectory: true)
        ) { candidate in
            isStrictlyNested(candidate, root: durableCanonical)
        }
        let ipcDir = chooseURL(
            "YULU_IPC_DIR",
            environment: environment,
            homeDirectory: homeDirectory,
            fallback: cacheDir
        ) { candidate in
            isSameOrNested(candidate, root: cacheCanonical)
        }
        let legacyReadOnlyDataDir = chooseURL(
            "YULU_LEGACY_READ_ONLY_DATA_DIR",
            environment: environment,
            homeDirectory: homeDirectory,
            fallback: defaultLegacy
        ) { candidate in
            !overlaps(candidate, durableCanonical)
                && !overlaps(candidate, cacheCanonical)
                && !overlaps(candidate, logsCanonical)
                && !overlaps(candidate, defaultMediaCanonical)
        }
        let legacyCanonical = legacyReadOnlyDataDir
        let configFile = durableDataDir.appendingPathComponent("config.json")
        let configReadFiles = [configFile, legacyReadOnlyDataDir.appendingPathComponent("config.json")]
        let mediaLibraryDir = resolveMediaLibrary(
            homeDirectory: homeDirectory,
            environment: environment,
            configReadFiles: configReadFiles,
            fallback: defaultMedia
        ) { candidate in
            !overlaps(candidate, durableCanonical)
                && !overlaps(candidate, cacheCanonical)
                && !overlaps(candidate, logsCanonical)
                && !overlaps(candidate, legacyCanonical)
        }
        return ApplicationDataPaths(
            durableDataDir: durableDataDir,
            configFile: configFile,
            modelsDir: modelsDir,
            cacheDir: cacheDir,
            ipcDir: ipcDir,
            logsDir: logsDir,
            mediaLibraryDir: mediaLibraryDir,
            legacyReadOnlyDataDir: legacyReadOnlyDataDir,
            configReadFiles: configReadFiles
        )
    }

    private static func absoluteURL(_ raw: String?, homeDirectory: URL) -> URL? {
        guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty,
              !value.contains("\0") else { return nil }
        if value.hasPrefix("~/") {
            let path = (homeDirectory.path as NSString).appendingPathComponent(String(value.dropFirst(2)))
            return URL(fileURLWithPath: (path as NSString).standardizingPath, isDirectory: true)
        }
        guard (value as NSString).isAbsolutePath else { return nil }
        return URL(fileURLWithPath: (value as NSString).standardizingPath, isDirectory: true)
    }

    private static func chooseURL(
        _ name: String,
        environment: [String: String],
        homeDirectory: URL,
        fallback: URL,
        safe: (URL) -> Bool
    ) -> URL {
        if let candidate = absoluteURL(environment[name], homeDirectory: homeDirectory),
           let resolved = canonical(candidate),
           safe(resolved) {
            return resolved
        }
        guard let resolvedFallback = canonical(fallback), safe(resolvedFallback) else {
            fatalError("unsafe Yulu standard path: \(name)")
        }
        return resolvedFallback
    }

    private static func canonical(_ url: URL) -> URL? {
        guard !url.path.contains("\0") else { return nil }
        var existing = URL(
            fileURLWithPath: (url.path as NSString).standardizingPath,
            isDirectory: true
        )
        var missing: [String] = []
        while true {
            var metadata = stat()
            let status = existing.path.withCString { lstat($0, &metadata) }
            if status == 0 {
                guard let resolvedPointer = existing.path.withCString({ realpath($0, nil) }) else {
                    return nil
                }
                defer { free(resolvedPointer) }
                let resolved = URL(
                    fileURLWithPath: String(cString: resolvedPointer),
                    isDirectory: true
                )
                var resolvedIsDirectory: ObjCBool = false
                guard FileManager.default.fileExists(atPath: resolved.path, isDirectory: &resolvedIsDirectory),
                      resolvedIsDirectory.boolValue else { return nil }
                return missing.reduce(resolved) { result, component in
                    result.appendingPathComponent(component, isDirectory: true)
                }
            }
            guard errno == ENOENT else { return nil }
            let parent = existing.deletingLastPathComponent()
            if parent.path == existing.path { return nil }
            missing.insert(existing.lastPathComponent, at: 0)
            existing = parent
        }
    }

    private static func comparisonComponents(_ value: URL) -> [String] {
        value.pathComponents.map { component in
            component.precomposedStringWithCanonicalMapping
                .lowercased(with: Locale(identifier: "en_US_POSIX"))
                .precomposedStringWithCanonicalMapping
        }
    }

    private static func hasComparisonRoot(_ url: URL, root: URL, strict: Bool) -> Bool {
        let path = comparisonComponents(url)
        let rootPath = comparisonComponents(root)
        return path.count >= rootPath.count + (strict ? 1 : 0)
            && Array(path.prefix(rootPath.count)) == rootPath
    }

    private static func isSameOrNested(_ url: URL, root: URL) -> Bool {
        hasComparisonRoot(url, root: root, strict: false)
    }

    private static func isStrictlyNested(_ url: URL, root: URL) -> Bool {
        hasComparisonRoot(url, root: root, strict: true)
    }

    private static func overlaps(_ left: URL, _ right: URL) -> Bool {
        isSameOrNested(left, root: right) || isSameOrNested(right, root: left)
    }

    private static func resolveMediaLibrary(
        homeDirectory: URL,
        environment: [String: String],
        configReadFiles: [URL],
        fallback: URL,
        safe: (URL) -> Bool
    ) -> URL {
        var candidates = [absoluteURL(environment["YULU_MEDIA_LIBRARY_DIR"], homeDirectory: homeDirectory)]
        for configFile in configReadFiles {
            guard let data = try? Data(contentsOf: configFile),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let audio = json["audio"] as? [String: Any],
                  let raw = audio["output_dir"] as? String else {
                candidates.append(nil)
                continue
            }
            candidates.append(absoluteURL(raw, homeDirectory: homeDirectory))
        }
        candidates.append(fallback)
        for candidate in candidates.compactMap({ $0 }) {
            if let resolved = canonical(candidate), safe(resolved) {
                return resolved
            }
        }
        fatalError("no safe Yulu Media Library path")
    }

    enum CodingKeys: String, CodingKey {
        case durableDataDir, configFile, modelsDir, cacheDir, ipcDir, logsDir
        case mediaLibraryDir, legacyReadOnlyDataDir, configReadFiles
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(durableDataDir.path, forKey: .durableDataDir)
        try container.encode(configFile.path, forKey: .configFile)
        try container.encode(modelsDir.path, forKey: .modelsDir)
        try container.encode(cacheDir.path, forKey: .cacheDir)
        try container.encode(ipcDir.path, forKey: .ipcDir)
        try container.encode(logsDir.path, forKey: .logsDir)
        try container.encode(mediaLibraryDir.path, forKey: .mediaLibraryDir)
        try container.encode(legacyReadOnlyDataDir.path, forKey: .legacyReadOnlyDataDir)
        try container.encode(configReadFiles.map(\.path), forKey: .configReadFiles)
    }

    var environment: [String: String] {
        [
            "YULU_APPLICATION_SUPPORT_DIR": durableDataDir.path,
            "YULU_MODELS_DIR": modelsDir.path,
            "YULU_CACHE_DIR": cacheDir.path,
            "YULU_IPC_DIR": ipcDir.path,
            "YULU_LOG_DIR": logsDir.path,
            "YULU_MEDIA_LIBRARY_DIR": mediaLibraryDir.path,
            "YULU_LEGACY_READ_ONLY_DATA_DIR": legacyReadOnlyDataDir.path,
        ]
    }

    static let environmentNames = [
        "YULU_APPLICATION_SUPPORT_DIR",
        "YULU_MODELS_DIR",
        "YULU_CACHE_DIR",
        "YULU_IPC_DIR",
        "YULU_LOG_DIR",
        "YULU_MEDIA_LIBRARY_DIR",
        "YULU_LEGACY_READ_ONLY_DATA_DIR",
    ]
}

struct HostServiceExecution: Encodable {
    static let declaredPort = 7777
    static let owner = "com.yulu.ui"

    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]

    static func make(
        layout: BundleLayout,
        applicationPaths: ApplicationDataPaths,
        hostNonce: String = UUID().uuidString
    ) -> HostServiceExecution {
        var environment = sanitizedRuntimeEnvironment()
        environment.merge(applicationPaths.environment) { _, contract in contract }
        environment["YULU_UI_PORT"] = String(declaredPort)
        environment["YULU_UI_DIST_WEB"] = layout.hostWeb.path
        environment["YULU_HOST_NONCE"] = hostNonce
        environment["YULU_SERVICE_OWNER"] = owner
        environment["YULU_SCRIPT_DIR"] = layout.bundledScriptDir.path
        environment["YULU_NATIVE_HELPER_DIR"] = layout.executableDir.path
        environment["YULU_PYTHON"] = layout.bundledPython.path
        environment["YULU_FFMPEG"] = layout.bundledFFmpeg.path
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PATH"] = "\(layout.bundledBin.path):\(layout.bundledPythonBin.path):/usr/bin:/bin:/usr/sbin:/sbin"
        return HostServiceExecution(
            executableURL: layout.hostNode,
            arguments: [layout.hostEntry.path],
            environment: environment
        )
    }

    enum CodingKeys: String, CodingKey {
        case executable, arguments, port, serviceOwner
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(executableURL.path, forKey: .executable)
        try container.encode(arguments, forKey: .arguments)
        try container.encode(Self.declaredPort, forKey: .port)
        try container.encode(Self.owner, forKey: .serviceOwner)
    }

    func replaceCurrentProcess() -> Never {
        var argv = ([executableURL.path] + arguments).map { strdup($0) as UnsafeMutablePointer<CChar>? }
        argv.append(nil)
        let environmentStrings: [String] = environment
            .map { name, value in "\(name)=\(value)" }
            .sorted()
        var envp: [UnsafeMutablePointer<CChar>?] = environmentStrings
            .map { strdup($0) as UnsafeMutablePointer<CChar>? }
        envp.append(nil)
        defer { argv.compactMap { $0 }.forEach { free($0) } }
        defer { envp.compactMap { $0 }.forEach { free($0) } }
        executableURL.path.withCString { executable in
            argv.withUnsafeMutableBufferPointer { buffer in
                envp.withUnsafeMutableBufferPointer { environmentBuffer in
                    _ = Darwin.execve(
                        executable,
                        buffer.baseAddress,
                        environmentBuffer.baseAddress
                    )
                }
            }
        }
        fputs("[Yulu] failed to exec bundled Host: \(String(cString: strerror(errno)))\n", stderr)
        exit(71)
    }
}

func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-launch" {
    try writeJSON(LaunchPolicy.evaluate(bundlePath: CommandLine.arguments[2]))
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-service-actions" {
    let recorder = ServiceActionRecorder()
    BackgroundServiceOwnership.registerBundledOwners(
        policy: LaunchPolicy.evaluate(bundlePath: CommandLine.arguments[2]),
        registrar: recorder
    )
    try writeJSON(recorder)
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-startup-plan" {
    try writeJSON(ProductionStartupPlan.make(
        policy: LaunchPolicy.evaluate(bundlePath: CommandLine.arguments[2])
    ))
    exit(0)
}

if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--inspect-registration-decision" {
    guard let decision = ServiceRegistrationDecision.make(
        policy: LaunchPolicy.evaluate(bundlePath: CommandLine.arguments[2]),
        status: CommandLine.arguments[3]
    ) else {
        fputs("invalid service registration status\n", stderr)
        exit(64)
    }
    try writeJSON(decision)
    exit(0)
}

if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--inspect-service-state" {
    guard let state = BackgroundServiceState.evaluate(
        status: CommandLine.arguments[2],
        running: CommandLine.arguments[3],
        ready: CommandLine.arguments[4]
    ) else {
        fputs("invalid service-state inspection input\n", stderr)
        exit(64)
    }
    try writeJSON(state)
    exit(0)
}

if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--inspect-service-presentation" {
    guard let state = BackgroundServiceState.evaluate(
        status: CommandLine.arguments[2],
        running: CommandLine.arguments[3],
        ready: CommandLine.arguments[4]
    ) else {
        fputs("invalid service-presentation inspection input\n", stderr)
        exit(64)
    }
    try writeJSON(BackgroundServicePresentation.make(state: state))
    exit(0)
}

if CommandLine.arguments.count == 8, CommandLine.arguments[1] == "--inspect-owner-presentations" {
    guard let host = BackgroundServiceState.evaluate(
        status: CommandLine.arguments[2],
        running: CommandLine.arguments[3],
        ready: CommandLine.arguments[4]
    ), let capture = BackgroundServiceState.evaluate(
        status: CommandLine.arguments[5],
        running: CommandLine.arguments[6],
        ready: CommandLine.arguments[7]
    ) else {
        fputs("invalid owner-presentations inspection input\n", stderr)
        exit(64)
    }
    try writeJSON(BundledServicesPresentation.make(host: host, capture: capture))
    exit(0)
}

if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--inspect-approval-remediation" {
    try writeJSON(ApprovalRemediation())
    exit(0)
}

if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--inspect-runtime-evidence" {
    guard let data = CommandLine.arguments[3].data(using: .utf8),
          let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let attestationData = CommandLine.arguments[4].data(using: .utf8),
          let attestationPayload = try? JSONSerialization.jsonObject(with: attestationData) as? [String: Any],
          let attestation = RuntimeOwnerAttestation.decode(attestationPayload),
          let evidence = RuntimeOwnerEvidence.evaluate(
            kind: CommandLine.arguments[2],
            payload: payload,
            attestation: attestation
          ) else {
        fputs("invalid runtime-evidence inspection input\n", stderr)
        exit(64)
    }
    try writeJSON(evidence)
    exit(0)
}

if CommandLine.arguments.count >= 4, CommandLine.arguments[1] == "--inspect-host-lock-attestation" {
    let ownerURL = URL(fileURLWithPath: CommandLine.arguments[2])
    var afterLockOpened: (() -> Bool)?
    #if YULU_DEVELOPMENT_SMOKE
    if let replacementPath = ProcessInfo.processInfo.environment["YULU_TEST_SWAP_HOST_LOCK_WITH"] {
        afterLockOpened = {
            let lockURL = ownerURL.deletingLastPathComponent()
            let parkedURL = lockURL
                .deletingLastPathComponent()
                .appendingPathComponent("host-instance.lock.anchored-original")
            return Darwin.rename(lockURL.path, parkedURL.path) == 0
                && Darwin.rename(replacementPath, lockURL.path) == 0
        }
    }
    #endif
    guard let attestation = hostRuntimeAttestation(
        ownerURL: ownerURL,
        expectedExecutable: URL(fileURLWithPath: CommandLine.arguments[3]),
        expectedArguments: Array(CommandLine.arguments.dropFirst(3)),
        afterLockOpened: afterLockOpened
    ) else {
        fputs("host lock attestation rejected\n", stderr)
        exit(66)
    }
    try writeJSON(attestation)
    exit(0)
}

if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--inspect-capture-runtime" {
    try writeJSON(captureRuntimeEvidence(
        socketURL: URL(fileURLWithPath: CommandLine.arguments[2]),
        expectedExecutable: URL(fileURLWithPath: CommandLine.arguments[3])
    ))
    exit(0)
}

if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--inspect-host-service" {
    let bundleURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let homeURL = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
    try writeJSON(HostServiceExecution.make(
        layout: BundleLayout(bundleURL: bundleURL),
        applicationPaths: ApplicationDataPaths.resolve(homeDirectory: homeURL, environment: [:]),
        hostNonce: "inspection"
    ))
    exit(0)
}

#if YULU_DEVELOPMENT_SMOKE
if CommandLine.arguments.count == 4,
   CommandLine.arguments[1] == "--development-run-host-service" {
    let bundleURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let homeURL = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
    HostServiceExecution.make(
        layout: BundleLayout(bundleURL: bundleURL),
        applicationPaths: ApplicationDataPaths.resolve(homeDirectory: homeURL, environment: [:]),
        hostNonce: "development-environment-inspection"
    ).replaceCurrentProcess()
}
#endif

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-bundle" {
    try writeJSON(ShellContract.describe(
        bundleURL: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    ))
    exit(0)
}

if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--inspect-build" {
    try writeJSON(BuildContract.current)
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-paths" {
    try writeJSON(ApplicationDataPaths.resolve(
        homeDirectory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true),
        environment: [:]
    ))
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-paths-environment" {
    try writeJSON(ApplicationDataPaths.resolve(
        homeDirectory: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true),
        environment: ProcessInfo.processInfo.environment
    ))
    exit(0)
}

final class ManagedComponent {
    let name: String
    let executableURL: URL
    let arguments: [String]
    let environment: [String: String]
    let currentDirectoryURL: URL?

    private var process: Process?
    private var shouldRun = false

    init(
        name: String,
        executableURL: URL,
        arguments: [String] = [],
        environment: [String: String] = ProcessInfo.processInfo.environment,
        currentDirectoryURL: URL? = nil
    ) {
        self.name = name
        self.executableURL = executableURL
        self.arguments = arguments
        self.environment = environment
        self.currentDirectoryURL = currentDirectoryURL
    }

    func start() {
        shouldRun = true
        launchIfNeeded()
    }

    func restart() {
        shouldRun = true
        if let process, process.isRunning {
            process.terminate()
        } else {
            self.process = nil
            launchIfNeeded()
        }
    }

    func stop() {
        shouldRun = false
        guard let process, process.isRunning else {
            self.process = nil
            return
        }
        process.terminate()
    }

    var isRunning: Bool {
        process?.isRunning == true
    }

    private func launchIfNeeded() {
        guard shouldRun, process == nil else { return }
        guard FileManager.default.isExecutableFile(atPath: executableURL.path) else {
            fputs("[Yulu] \(name) executable unavailable: \(executableURL.path)\n", stderr)
            return
        }
        let child = Process()
        child.executableURL = executableURL
        child.arguments = arguments
        child.environment = environment
        child.currentDirectoryURL = currentDirectoryURL
        child.terminationHandler = { [weak self, weak child] _ in
            DispatchQueue.main.async {
                guard let self, let child, self.process === child else { return }
                self.process = nil
                guard self.shouldRun else { return }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    self.launchIfNeeded()
                }
            }
        }
        do {
            try child.run()
            process = child
        } catch {
            fputs("[Yulu] failed to launch \(name): \(error)\n", stderr)
            process = nil
        }
    }
}

final class ProductSupervisor {
    private let host: ManagedComponent
    private let capture: ManagedComponent
    let hostNonce: String

    init(
        layout: BundleLayout,
        port: Int,
        developmentNode: URL? = nil,
        developmentScriptDir: URL? = nil,
        developmentSmoke: Bool = false,
        hostNonce: String = UUID().uuidString,
        applicationPaths suppliedApplicationPaths: ApplicationDataPaths? = nil
    ) {
        self.hostNonce = hostNonce
        let applicationPaths: ApplicationDataPaths
        if let suppliedApplicationPaths {
            applicationPaths = suppliedApplicationPaths
        } else {
            applicationPaths = ApplicationDataPaths.resolve(environment: [:])
        }
        var hostEnvironment = sanitizedRuntimeEnvironment()
        hostEnvironment.merge(applicationPaths.environment) { _, contract in contract }
        hostEnvironment["YULU_UI_PORT"] = String(port)
        hostEnvironment["YULU_UI_DIST_WEB"] = layout.hostWeb.path
        hostEnvironment["YULU_HOST_NONCE"] = hostNonce
        hostEnvironment["YULU_SCRIPT_DIR"] = developmentScriptDir?.path
            ?? layout.bundledScriptDir.path
        hostEnvironment["YULU_NATIVE_HELPER_DIR"] = layout.executableDir.path
        if developmentSmoke {
            hostEnvironment["YULU_DEV_SMOKE"] = "1"
        }
        hostEnvironment["YULU_PYTHON"] = layout.bundledPython.path
        hostEnvironment["YULU_FFMPEG"] = layout.bundledFFmpeg.path
        hostEnvironment["PYTHONDONTWRITEBYTECODE"] = "1"
        let bundledRuntimePath = "\(layout.bundledBin.path):\(layout.bundledPythonBin.path):/usr/bin:/bin:/usr/sbin:/sbin"
        hostEnvironment["PATH"] = bundledRuntimePath
        host = ManagedComponent(
            name: "Host",
            executableURL: developmentNode ?? layout.hostNode,
            arguments: [layout.hostEntry.path],
            environment: hostEnvironment,
            currentDirectoryURL: layout.hostEntry.deletingLastPathComponent()
        )
        var captureEnvironment = sanitizedRuntimeEnvironment()
        captureEnvironment.merge(applicationPaths.environment) { _, contract in contract }
        captureEnvironment["YULU_SCRIPT_DIR"] = developmentScriptDir?.path
            ?? layout.bundledScriptDir.path
        captureEnvironment["YULU_PYTHON"] = layout.bundledPython.path
        captureEnvironment["YULU_FFMPEG"] = layout.bundledFFmpeg.path
        captureEnvironment["PYTHONDONTWRITEBYTECODE"] = "1"
        captureEnvironment["PATH"] = bundledRuntimePath
        capture = ManagedComponent(
            name: "Capture",
            executableURL: layout.captureExecutable,
            environment: captureEnvironment
        )
    }

    func start() {
        host.start()
        capture.start()
    }

    func startHostForDevelopmentSmoke() {
        host.start()
    }

    func restartHost() { host.restart() }
    func restartCapture() { capture.restart() }
    var hostIsRunning: Bool { host.isRunning }

    var pathContractEnvironments: ComponentPathEnvironments {
        func contractOnly(_ environment: [String: String]) -> [String: String] {
            Dictionary(uniqueKeysWithValues: ApplicationDataPaths.environmentNames.compactMap { name in
                environment[name].map { (name, $0) }
            })
        }
        return ComponentPathEnvironments(
            host: contractOnly(host.environment),
            capture: contractOnly(capture.environment)
        )
    }

    func stop() {
        host.stop()
        capture.stop()
    }
}

struct ComponentPathEnvironments: Encodable {
    let host: [String: String]
    let capture: [String: String]
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-component-paths" {
    let homeDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let applicationPaths = ApplicationDataPaths.resolve(homeDirectory: homeDirectory, environment: [:])
    let supervisor = ProductSupervisor(
        layout: BundleLayout(bundleURL: URL(fileURLWithPath: "/Applications/Yulu.app", isDirectory: true)),
        port: 7777,
        applicationPaths: applicationPaths
    )
    try writeJSON(supervisor.pathContractEnvironments)
    exit(0)
}

if CommandLine.arguments.count == 3, CommandLine.arguments[1] == "--inspect-component-paths-environment" {
    let homeDirectory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let applicationPaths = ApplicationDataPaths.resolve(
        homeDirectory: homeDirectory,
        environment: ProcessInfo.processInfo.environment
    )
    let supervisor = ProductSupervisor(
        layout: BundleLayout(bundleURL: URL(fileURLWithPath: "/Applications/Yulu.app", isDirectory: true)),
        port: 7777,
        applicationPaths: applicationPaths
    )
    try writeJSON(supervisor.pathContractEnvironments)
    exit(0)
}

if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--run-host-service" {
    let policy = LaunchPolicy.evaluate(bundlePath: Bundle.main.bundleURL.path)
    guard policy.persistentRegistrationAllowed else {
        fputs("[Yulu] Host service refuses to run outside /Applications/Yulu.app\n", stderr)
        exit(78)
    }
    HostServiceExecution.make(
        layout: BundleLayout(bundleURL: Bundle.main.bundleURL),
        applicationPaths: ApplicationDataPaths.resolve(environment: [:])
    ).replaceCurrentProcess()
}

func sanitizedRuntimeEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    for key in Array(environment.keys) {
        if key == "NODE_OPTIONS"
            || key == "NODE_PATH"
            || key.hasPrefix("PYTHON")
            || key.hasPrefix("DYLD_")
            || key.hasPrefix("YULU_DEV_")
            || key.hasPrefix("YULU_LOCAL_CAPTION_")
            || key == "YULU_NATIVE_HELPER_DIR" {
            environment.removeValue(forKey: key)
        }
    }
    return environment
}

func healthResponseIsValid(data: Data?, response: URLResponse?, nonce: String) -> Bool {
    guard (response as? HTTPURLResponse)?.statusCode == 200,
          let data,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return false
    }
    return json["status"] as? String == "ok"
        && json["instanceNonce"] as? String == nonce
}

func processExecutableMatches(pid: Int, expectedURL: URL) -> Bool {
    guard pid > 1 else { return false }
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let count = proc_pidpath(Int32(pid), &buffer, UInt32(buffer.count))
    guard count > 0 else { return false }
    let actual = URL(fileURLWithPath: String(cString: buffer))
        .standardizedFileURL
        .resolvingSymlinksInPath()
    let expected = expectedURL.standardizedFileURL.resolvingSymlinksInPath()
    return actual.path == expected.path
}

func processStartGeneration(pid: Int) -> String? {
    guard pid > 1 else { return nil }
    var info = proc_bsdinfo()
    let expectedSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(
        Int32(pid),
        PROC_PIDTBSDINFO,
        0,
        &info,
        expectedSize
    ) == expectedSize else { return nil }
    return "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)"
}

func processArguments(pid: Int) -> [String]? {
    guard pid > 1 else { return nil }
    var argMaxMIB = [Int32(CTL_KERN), Int32(KERN_ARGMAX)]
    var argMax = Int32(0)
    var argMaxSize = MemoryLayout<Int32>.size
    guard sysctl(&argMaxMIB, 2, &argMax, &argMaxSize, nil, 0) == 0,
          argMax > 0,
          argMax <= 2 * 1024 * 1024 else { return nil }

    var bytes = [UInt8](repeating: 0, count: Int(argMax))
    var byteCount = bytes.count
    var processMIB = [Int32(CTL_KERN), Int32(KERN_PROCARGS2), Int32(pid)]
    let result = bytes.withUnsafeMutableBytes { storage in
        sysctl(&processMIB, 3, storage.baseAddress, &byteCount, nil, 0)
    }
    guard result == 0,
          byteCount >= MemoryLayout<Int32>.size else { return nil }
    bytes.removeSubrange(byteCount..<bytes.count)

    let argumentCount = bytes.withUnsafeBytes {
        Int($0.loadUnaligned(as: Int32.self))
    }
    guard argumentCount > 0, argumentCount <= 4096 else { return nil }
    var cursor = MemoryLayout<Int32>.size
    while cursor < bytes.count, bytes[cursor] != 0 { cursor += 1 }
    guard cursor < bytes.count else { return nil }
    while cursor < bytes.count, bytes[cursor] == 0 { cursor += 1 }

    var arguments: [String] = []
    for _ in 0..<argumentCount {
        let start = cursor
        while cursor < bytes.count, bytes[cursor] != 0 { cursor += 1 }
        guard cursor < bytes.count else { return nil }
        arguments.append(String(decoding: bytes[start..<cursor], as: UTF8.self))
        cursor += 1
    }
    return arguments
}

func processArgumentsMatch(pid: Int, expected: [String]) -> Bool {
    guard !expected.isEmpty,
          let actual = processArguments(pid: pid),
          actual.count == expected.count else { return false }
    let actualExecutable = URL(fileURLWithPath: actual[0])
        .standardizedFileURL
        .resolvingSymlinksInPath()
    let expectedExecutable = URL(fileURLWithPath: expected[0])
        .standardizedFileURL
        .resolvingSymlinksInPath()
    return actualExecutable.path == expectedExecutable.path
        && Array(actual.dropFirst()) == Array(expected.dropFirst())
}

private struct HostLockOwner: Decodable {
    let pid: Int
    let token: String
}

func hostRuntimeAttestation(
    ownerURL: URL,
    expectedExecutable: URL,
    expectedArguments: [String],
    afterLockOpened: (() -> Bool)? = nil
) -> RuntimeOwnerAttestation? {
    let lockURL = ownerURL.deletingLastPathComponent()
    let rootURL = lockURL.deletingLastPathComponent()
    let rootFD = Darwin.open(rootURL.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard rootFD >= 0 else { return nil }
    defer { Darwin.close(rootFD) }
    var rootMetadata = stat()
    guard Darwin.fstat(rootFD, &rootMetadata) == 0,
          (rootMetadata.st_mode & S_IFMT) == S_IFDIR,
          (rootMetadata.st_mode & mode_t(0o777)) == mode_t(0o700),
          rootMetadata.st_uid == geteuid() else { return nil }

    let lockFD = Darwin.openat(rootFD, "host-instance.lock", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard lockFD >= 0 else { return nil }
    defer { Darwin.close(lockFD) }
    var lockMetadata = stat()
    guard Darwin.fstat(lockFD, &lockMetadata) == 0,
          (lockMetadata.st_mode & S_IFMT) == S_IFDIR,
          (lockMetadata.st_mode & mode_t(0o777)) == mode_t(0o700),
          lockMetadata.st_uid == geteuid(),
          afterLockOpened?() != false else { return nil }

    let fd = Darwin.openat(lockFD, "owner.json", O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { return nil }
    defer { Darwin.close(fd) }
    var metadata = stat()
    guard Darwin.fstat(fd, &metadata) == 0,
          (metadata.st_mode & S_IFMT) == S_IFREG,
          (metadata.st_mode & mode_t(0o777)) == mode_t(0o600),
          metadata.st_uid == geteuid(),
          metadata.st_size > 0,
          metadata.st_size <= 4096 else { return nil }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while data.count < 4096 {
        let count = Darwin.read(fd, &buffer, min(buffer.count, 4096 - data.count))
        if count < 0 { return nil }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    guard data.count == metadata.st_size,
          let owner = try? JSONDecoder().decode(HostLockOwner.self, from: data),
          owner.pid > 1,
          owner.token.range(of: "^[A-Za-z0-9-]{16,}$", options: .regularExpression) != nil else {
        return nil
    }
    let generationBefore = processStartGeneration(pid: owner.pid)
    let executableMatches = processExecutableMatches(
        pid: owner.pid,
        expectedURL: expectedExecutable
    )
    let argumentsMatch = processArgumentsMatch(
        pid: owner.pid,
        expected: expectedArguments
    )
    let generationAfter = processStartGeneration(pid: owner.pid)
    return RuntimeOwnerAttestation(
        ownerPID: owner.pid,
        authorityToken: owner.token,
        generation: generationAfter,
        executableMatches: executableMatches,
        argumentsMatch: argumentsMatch,
        generationStable: generationBefore != nil && generationBefore == generationAfter
    )
}

func captureRuntimeEvidence(socketURL: URL, expectedExecutable: URL) -> RuntimeOwnerEvidence {
    let socketPath = socketURL.path
    guard socketPath.utf8.count <= 103 else {
        return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
    }
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
        return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
    }
    defer { Darwin.close(fd) }
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    _ = socketPath.withCString { pointer in
        strncpy(&address.sun_path.0, pointer, 103)
    }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else {
        return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
    }
    var peerPID: Int32 = 0
    var peerPIDSize = socklen_t(MemoryLayout<Int32>.size)
    var peerUID = uid_t(0)
    var peerGID = gid_t(0)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &peerPIDSize) == 0,
          getpeereid(fd, &peerUID, &peerGID) == 0,
          peerPID > 1,
          peerUID == geteuid() else {
        return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
    }
    let generationBefore = processStartGeneration(pid: Int(peerPID))
    let request = Data("{\"action\":\"status\"}".utf8)
    guard request.withUnsafeBytes({ Darwin.write(fd, $0.baseAddress, request.count) }) == request.count else {
        return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
    }
    shutdown(fd, SHUT_WR)
    var response = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while response.count < 65_536 {
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count <= 0 { break }
        response.append(buffer, count: count)
    }
    guard !response.isEmpty,
          response.count < 65_536,
          let payload = try? JSONSerialization.jsonObject(with: response) as? [String: Any] else {
        return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
    }
    let generationAfterResponse = processStartGeneration(pid: Int(peerPID))
    let executableMatches = processExecutableMatches(
        pid: Int(peerPID),
        expectedURL: expectedExecutable
    )
    #if YULU_DEVELOPMENT_SMOKE
    if let marker = ProcessInfo.processInfo.environment["YULU_TEST_CAPTURE_AFTER_IDENTITY_MARKER"] {
        _ = FileManager.default.createFile(atPath: marker, contents: Data())
    }
    if let delay = ProcessInfo.processInfo.environment["YULU_TEST_CAPTURE_POST_IDENTITY_DELAY_US"],
       let microseconds = useconds_t(delay) {
        usleep(microseconds)
    }
    #endif
    let generationAfterIdentity = processStartGeneration(pid: Int(peerPID))
    let attestation = RuntimeOwnerAttestation(
        ownerPID: Int(peerPID),
        authorityToken: nil,
        generation: generationAfterIdentity,
        executableMatches: executableMatches,
        argumentsMatch: true,
        generationStable: generationBefore != nil
            && generationBefore == generationAfterResponse
            && generationAfterResponse == generationAfterIdentity
    )
    return RuntimeOwnerEvidence.evaluate(
        kind: "capture",
        payload: payload,
        attestation: attestation
    ) ?? RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
}

#if YULU_DEVELOPMENT_SMOKE
struct DevelopmentSmokeReport: Encodable {
    let status: String
    let healthURL: String
    let hostEntry: String
    let hostReady: Bool
    let captureReady: Bool
    let captureStarted: Bool
}

func developmentSmokeApplicationPaths(environment: [String: String]) throws -> ApplicationDataPaths {
    guard let rawHome = environment["HOME"]?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rawHome.isEmpty,
          !rawHome.contains("\0"),
          (rawHome as NSString).isAbsolutePath else {
        throw NSError(
            domain: "YuluDevelopmentSmoke",
            code: 5,
            userInfo: [NSLocalizedDescriptionKey: "development smoke requires an absolute HOME"]
        )
    }
    let homeDirectory = URL(
        fileURLWithPath: (rawHome as NSString).standardizingPath,
        isDirectory: true
    )
    return ApplicationDataPaths.resolve(homeDirectory: homeDirectory, environment: [:])
}

if CommandLine.arguments.count == 2,
   CommandLine.arguments[1] == "--inspect-development-smoke-paths" {
    try writeJSON(developmentSmokeApplicationPaths(environment: ProcessInfo.processInfo.environment))
    exit(0)
}

func hostIsHealthy(url: URL, nonce: String) -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var healthy = false
    URLSession.shared.dataTask(with: url) { data, response, _ in
        defer { semaphore.signal() }
        healthy = healthResponseIsValid(data: data, response: response, nonce: nonce)
    }.resume()
    _ = semaphore.wait(timeout: .now() + 1)
    return healthy
}

func runCaptureSelfTest(layout: BundleLayout) -> Bool {
    guard FileManager.default.isExecutableFile(atPath: layout.captureExecutable.path) else {
        return false
    }
    let process = Process()
    process.executableURL = layout.captureExecutable
    process.arguments = ["--self-test"]
    let inheritedPath = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"
    process.environment = [
        "HOME": ProcessInfo.processInfo.environment["HOME"] ?? "/private/tmp",
        "YULU_PYTHON": layout.bundledPython.path,
        "YULU_FFMPEG": layout.bundledFFmpeg.path,
        "PYTHONDONTWRITEBYTECODE": "1",
        "PATH": "\(layout.bundledBin.path):\(layout.bundledPythonBin.path):\(inheritedPath)",
    ]
    process.standardOutput = Pipe()
    process.standardError = Pipe()
    do {
        try process.run()
        process.waitUntilExit()
        return process.terminationStatus == 0
    } catch {
        return false
    }
}

func runDevelopmentSmoke(layout: BundleLayout, port: Int) throws -> DevelopmentSmokeReport {
    guard FileManager.default.isExecutableFile(atPath: layout.hostNode.path) else {
        throw NSError(
            domain: "YuluDevelopmentSmoke",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "bundled Node is missing: \(layout.hostNode.path)"]
        )
    }
    guard FileManager.default.isReadableFile(atPath: layout.hostEntry.path) else {
        throw NSError(
            domain: "YuluDevelopmentSmoke",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "bundled Host entry is missing: \(layout.hostEntry.path)"]
        )
    }
    guard runCaptureSelfTest(layout: layout) else {
        throw NSError(
            domain: "YuluDevelopmentSmoke",
            code: 4,
            userInfo: [NSLocalizedDescriptionKey: "bundled Capture self-test failed"]
        )
    }
    let applicationPaths = try developmentSmokeApplicationPaths(
        environment: ProcessInfo.processInfo.environment
    )
    let supervisor = ProductSupervisor(
        layout: layout,
        port: port,
        developmentSmoke: true,
        applicationPaths: applicationPaths
    )
    supervisor.startHostForDevelopmentSmoke()
    defer {
        supervisor.stop()
        Thread.sleep(forTimeInterval: 0.5)
    }
    let healthURL = URL(string: "http://127.0.0.1:\(port)/healthz")!
    let deadline = Date().addingTimeInterval(30)
    while Date() < deadline {
        if supervisor.hostIsRunning && hostIsHealthy(url: healthURL, nonce: supervisor.hostNonce) {
            return DevelopmentSmokeReport(
                status: "ok",
                healthURL: healthURL.absoluteString,
                hostEntry: layout.hostEntry.path,
                hostReady: true,
                captureReady: true,
                captureStarted: false
            )
        }
        Thread.sleep(forTimeInterval: 0.25)
    }
    throw NSError(
        domain: "YuluDevelopmentSmoke",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "bundled Host did not become healthy at \(healthURL.absoluteString)"]
    )
}
#endif

final class YuluApplication: NSObject, NSApplicationDelegate {
    private let launchPolicy: LaunchPolicy
    private let layout: BundleLayout
    private let port: Int
    private let applicationPaths: ApplicationDataPaths?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var serviceWindow: NSWindow?
    private let backgroundServices = BackgroundServiceRegistry()
    private var hostPollAttempts = 0
    private var pollGeneration = 0
    private var hostEvidence = RuntimeOwnerEvidence(
        running: false,
        capabilityReady: nil,
        ownerPID: nil
    )
    private var captureEvidence = RuntimeOwnerEvidence(
        running: false,
        capabilityReady: nil,
        ownerPID: nil
    )

    init(launchPolicy: LaunchPolicy, layout: BundleLayout, port: Int) {
        self.launchPolicy = launchPolicy
        self.layout = layout
        self.port = port
        self.applicationPaths = launchPolicy.installed
            ? ApplicationDataPaths.resolve(environment: [:])
            : nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMainMenu()
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 680),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Yulu"
        if let guidance = launchPolicy.guidance {
            window.contentView = centeredMessage(guidance, detail: "Yulu runs services and updates only from /Applications/Yulu.app.")
        } else {
            window.contentView = centeredMessage("Starting Yulu…", detail: "Waiting for the bundled Host.")
            backgroundServices.registerBundledOwners(policy: launchPolicy)
            beginServicePolling()
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard launchPolicy.installed else { return }
        refreshServiceWindow()
        beginServicePolling()
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    private func centeredMessage(_ title: String, detail: String) -> NSView {
        let titleLabel = NSTextField(wrappingLabelWithString: title)
        titleLabel.alignment = .center
        titleLabel.font = .systemFont(ofSize: 20, weight: .semibold)
        let detailLabel = NSTextField(wrappingLabelWithString: detail)
        detailLabel.alignment = .center
        detailLabel.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [titleLabel, detailLabel])
        stack.orientation = .vertical
        stack.spacing = 10
        stack.alignment = .centerX
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: content.leadingAnchor, constant: 48),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: content.trailingAnchor, constant: -48),
        ])
        return content
    }

    private func installMainMenu() {
        let root = NSMenu()
        let appItem = NSMenuItem()
        root.addItem(appItem)
        let appMenu = NSMenu(title: "Yulu")
        appMenu.addItem(withTitle: "About Yulu", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Yulu", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let navigateItem = NSMenuItem()
        root.addItem(navigateItem)
        let navigate = NSMenu(title: "Navigate")
        addRoute("Open Yulu", route: "/", key: "1", to: navigate)
        addRoute("Onboarding", route: "/onboarding", key: "2", to: navigate)
        addRoute("Inbox", route: "/inbox", key: "3", to: navigate)
        addRoute("Settings", route: "/settings", key: ",", to: navigate)
        navigateItem.submenu = navigate

        let componentsItem = NSMenuItem()
        root.addItem(componentsItem)
        let components = NSMenu(title: "Components")
        let serviceStatus = components.addItem(
            withTitle: "Background Services…",
            action: #selector(onShowBackgroundServices),
            keyEquivalent: ""
        )
        serviceStatus.target = self
        let backgroundSettings = components.addItem(
            withTitle: "Background Item Settings…",
            action: #selector(onOpenBackgroundSettings),
            keyEquivalent: ""
        )
        backgroundSettings.target = self
        componentsItem.submenu = components
        NSApp.mainMenu = root
    }

    private func addRoute(_ title: String, route: String, key: String, to menu: NSMenu) {
        let item = menu.addItem(withTitle: title, action: #selector(onOpenRoute(_:)), keyEquivalent: key)
        item.target = self
        item.representedObject = route
    }

    @objc private func onOpenRoute(_ sender: NSMenuItem) {
        guard launchPolicy.installed, let route = sender.representedObject as? String else { return }
        open(route: route)
    }

    @objc private func onShowBackgroundServices() {
        guard launchPolicy.installed else { return }
        refreshServiceWindow(show: true)
    }

    @objc private func onOpenBackgroundSettings() {
        guard launchPolicy.installed else { return }
        SMAppService.openSystemSettingsLoginItems()
    }

    private func refreshServiceWindow(show: Bool = false) {
        guard launchPolicy.installed else { return }
        let statuses = backgroundServices.statuses()
        func state(_ plistName: String, evidence: RuntimeOwnerEvidence) -> BackgroundServiceState {
            let readiness = evidence.capabilityReady.map { $0 ? "true" : "false" } ?? "unknown"
            return BackgroundServiceState.evaluate(
                status: statuses[plistName] ?? "notFound",
                running: evidence.running ? "true" : "false",
                ready: readiness
            ) ?? BackgroundServiceState(
                registration: .notFound,
                systemApproval: .unknown,
                runningHealth: .stopped,
                capabilityReadiness: .blocked
            )
        }
        let presentation = BundledServicesPresentation.make(
            host: state("com.yulu.ui.plist", evidence: hostEvidence),
            capture: state("com.yulu.audiodaemon.plist", evidence: captureEvidence)
        )
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 16
        var needsRemediation = false
        for (index, service) in presentation.services.enumerated() {
            let titleLabel = NSTextField(labelWithString: service.label)
            titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
            stack.addArrangedSubview(titleLabel)
            let detail = service.state.rows
                .map { "\($0.label): \($0.value)" }
                .joined(separator: "\n")
            stack.addArrangedSubview(NSTextField(wrappingLabelWithString: detail))
            let plistName = BackgroundServiceDescriptor.bundledOwners[index].plistName
            if let error = backgroundServices.registrationErrors[plistName] {
                let errorLabel = NSTextField(wrappingLabelWithString: "Registration error: \(error)")
                errorLabel.textColor = .systemRed
                stack.addArrangedSubview(errorLabel)
            }
            needsRemediation = needsRemediation || service.state.remediation != nil
        }
        if needsRemediation {
            stack.addArrangedSubview(NSButton(
                title: "Open Login Items Settings…",
                target: self,
                action: #selector(onOpenBackgroundSettings)
            ))
        }
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 430))
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
        ])
        let serviceWindow: NSWindow
        if let existing = self.serviceWindow {
            serviceWindow = existing
            serviceWindow.contentView = content
        } else {
            serviceWindow = NSWindow(
                contentRect: content.frame,
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            serviceWindow.title = "Background Services"
            serviceWindow.contentView = content
            serviceWindow.center()
            self.serviceWindow = serviceWindow
        }
        if show { serviceWindow.makeKeyAndOrderFront(nil) }
    }

    private func beginServicePolling() {
        pollGeneration += 1
        hostPollAttempts = 0
        pollHost(generation: pollGeneration)
    }

    private func pollHost(generation: Int) {
        guard launchPolicy.installed,
              generation == pollGeneration,
              let applicationPaths else { return }
        pollCapture(generation: generation)
        hostPollAttempts += 1
        let url = URL(string: "http://127.0.0.1:\(port)/healthz")!
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            guard let self else { return }
            let payload = data.flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
            }
            let ownerURL = applicationPaths.legacyReadOnlyDataDir
                .appendingPathComponent("host-instance.lock/owner.json")
            let attestation = hostRuntimeAttestation(
                ownerURL: ownerURL,
                expectedExecutable: self.layout.hostNode,
                expectedArguments: [self.layout.hostNode.path, self.layout.hostEntry.path]
            )
            let evidence = payload.flatMap { payload in
                attestation.flatMap {
                    RuntimeOwnerEvidence.evaluate(
                        kind: "host",
                        payload: payload,
                        attestation: $0
                    )
                }
            } ?? RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
            let responseHealthy = (response as? HTTPURLResponse)?.statusCode == 200
                && evidence.running
            DispatchQueue.main.async {
                guard generation == self.pollGeneration else { return }
                self.hostEvidence = evidence
                self.refreshServiceWindow()
                if responseHealthy {
                    self.hostPollAttempts = 0
                    if self.webView == nil { self.open(route: "/") }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        self.pollHost(generation: generation)
                    }
                } else if self.hostPollAttempts < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.pollHost(generation: generation)
                    }
                } else {
                    self.window?.contentView = self.centeredMessage(
                        "Yulu Host is unavailable",
                        detail: "Choose Components > Background Services for registration and approval status."
                    )
                }
            }
        }.resume()
    }

    private func pollCapture(generation: Int) {
        guard let applicationPaths else { return }
        let socketURL = applicationPaths.ipcDir
            .appendingPathComponent("audio_daemon.sock")
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let evidence = captureRuntimeEvidence(
                socketURL: socketURL,
                expectedExecutable: self.layout.captureExecutable
            )
            DispatchQueue.main.async {
                guard generation == self.pollGeneration else { return }
                self.captureEvidence = evidence
                self.refreshServiceWindow()
            }
        }
    }

    private func open(route: String) {
        let web: WKWebView
        if let webView {
            web = webView
        } else {
            web = WKWebView(frame: .zero)
            web.autoresizingMask = [.width, .height]
            webView = web
            window?.contentView = web
        }
        guard let url = URL(string: "http://127.0.0.1:\(port)\(route)") else { return }
        web.load(URLRequest(url: url))
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}

let policy = LaunchPolicy.evaluate(bundlePath: Bundle.main.bundleURL.path)
let layout = BundleLayout(bundleURL: Bundle.main.bundleURL)
#if YULU_DEVELOPMENT_SMOKE
let port = Int(ProcessInfo.processInfo.environment["YULU_UI_PORT"] ?? "7777") ?? 7777
if CommandLine.arguments.count == 2, CommandLine.arguments[1] == "--development-smoke" {
    do {
        try writeJSON(runDevelopmentSmoke(layout: layout, port: port))
        exit(0)
    } catch {
        fputs("development Yulu.app smoke failed: \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}
#else
let port = HostServiceExecution.declaredPort
#endif
let app = NSApplication.shared
let delegate = YuluApplication(launchPolicy: policy, layout: layout, port: port)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
