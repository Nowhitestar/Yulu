import Cocoa
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
        hostNonce: String = UUID().uuidString
    ) {
        self.hostNonce = hostNonce
        var hostEnvironment = sanitizedRuntimeEnvironment()
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

    func stop() {
        host.stop()
        capture.stop()
    }
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
