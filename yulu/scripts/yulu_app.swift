import Cocoa
import Darwin
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
    let executable: String
    let arguments: [String]
    let restartable: Bool
    let bundleIdentifier: String?

    enum CodingKeys: String, CodingKey {
        case executable, arguments, restartable, bundleIdentifier
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(executable, forKey: .executable)
        if !arguments.isEmpty {
            try container.encode(arguments, forKey: .arguments)
        }
        try container.encode(restartable, forKey: .restartable)
        if let bundleIdentifier {
            try container.encode(bundleIdentifier, forKey: .bundleIdentifier)
        }
    }
}

struct ShellContract: Encodable {
    let windowURL: String
    let menuRoutes: [String]
    let host: ComponentContract
    let capture: ComponentContract

    static func describe(bundleURL: URL, port: Int = 7777) -> ShellContract {
        let layout = BundleLayout(bundleURL: bundleURL)
        return ShellContract(
            windowURL: "http://127.0.0.1:\(port)/",
            menuRoutes: ["/", "/onboarding", "/inbox", "/settings"],
            host: ComponentContract(
                executable: layout.hostNode.path,
                arguments: [layout.hostEntry.path],
                restartable: true,
                bundleIdentifier: nil
            ),
            capture: ComponentContract(
                executable: layout.captureExecutable.path,
                arguments: [],
                restartable: true,
                bundleIdentifier: "com.yulu.audiodaemon"
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

#if YULU_DEVELOPMENT_SMOKE
struct DevelopmentSmokeReport: Encodable {
    let status: String
    let healthURL: String
    let hostEntry: String
    let hostReady: Bool
    let captureReady: Bool
    let captureStarted: Bool
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
    let supervisor = ProductSupervisor(
        layout: layout,
        port: port,
        developmentSmoke: true
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
    private var window: NSWindow?
    private var webView: WKWebView?
    private var supervisor: ProductSupervisor?
    private var hostPollAttempts = 0

    init(launchPolicy: LaunchPolicy, layout: BundleLayout, port: Int) {
        self.launchPolicy = launchPolicy
        self.layout = layout
        self.port = port
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
            let supervisor = ProductSupervisor(layout: layout, port: port)
            self.supervisor = supervisor
            supervisor.start()
            pollHost()
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        supervisor?.stop()
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
        let restartHost = components.addItem(withTitle: "Restart Host", action: #selector(onRestartHost), keyEquivalent: "")
        restartHost.target = self
        let restartCapture = components.addItem(withTitle: "Restart Capture", action: #selector(onRestartCapture), keyEquivalent: "")
        restartCapture.target = self
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

    @objc private func onRestartHost() {
        guard launchPolicy.installed else { return }
        hostPollAttempts = 0
        supervisor?.restartHost()
        pollHost()
    }

    @objc private func onRestartCapture() {
        guard launchPolicy.installed else { return }
        supervisor?.restartCapture()
    }

    private func pollHost() {
        guard launchPolicy.installed else { return }
        hostPollAttempts += 1
        let url = URL(string: "http://127.0.0.1:\(port)/healthz")!
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            guard let self else { return }
            let responseHealthy = healthResponseIsValid(
                data: data,
                response: response,
                nonce: self.supervisor?.hostNonce ?? ""
            )
            DispatchQueue.main.async {
                let healthy = responseHealthy && self.supervisor?.hostIsRunning == true
                if healthy {
                    self.open(route: "/")
                } else if self.hostPollAttempts < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.pollHost() }
                } else {
                    self.window?.contentView = self.centeredMessage(
                        "Yulu Host is unavailable",
                        detail: "Choose Components > Restart Host to try again."
                    )
                }
            }
        }.resume()
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
let port = Int.random(in: 49152...65535)
#endif
let app = NSApplication.shared
let delegate = YuluApplication(launchPolicy: policy, layout: layout, port: port)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
