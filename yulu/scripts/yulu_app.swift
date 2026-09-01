import Cocoa
import Darwin
import Security
import ServiceManagement
import WebKit
#if canImport(Sparkle)
import Sparkle
#endif

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

protocol PersistentServiceMutating: PersistentServiceRegistering {
    func unregister(_ service: BackgroundServiceDescriptor)
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
            register: policy.persistentRegistrationAllowed
                && (status == "notRegistered" || status == "notFound")
        )
    }
}

enum FreshInstallRegistrationDisposition: String, Encodable {
    case pending
    case awaitingApproval = "awaiting_approval"
    case verifyHealth = "verify_health"
    case blocked

    static func evaluate(statuses: [String], attempt: Int) -> FreshInstallRegistrationDisposition? {
        let accepted = ["notRegistered", "enabled", "requiresApproval", "notFound"]
        guard attempt >= 0,
              statuses.count == BackgroundServiceDescriptor.bundledOwners.count,
              statuses.allSatisfy({ accepted.contains($0) }) else { return nil }
        if statuses.allSatisfy({ $0 == "enabled" }) { return .verifyHealth }
        if statuses.contains("requiresApproval") { return .awaitingApproval }
        return attempt < 40 ? .pending : .blocked
    }
}

enum FreshInstallHealthDisposition: String, Encodable {
    case pending
    case committed
    case blocked

    static func evaluate(
        hostReady: Bool,
        captureReady: Bool,
        timedOut: Bool
    ) -> FreshInstallHealthDisposition {
        if hostReady && captureReady { return .committed }
        return timedOut ? .blocked : .pending
    }
}

enum FreshInstallRecoveryAction: String {
    case cancel
    case retry
}

struct FreshInstallRecoveryPlan: Encodable {
    let unregister: [String]
    let retryAfterUnregistration: Bool

    static func evaluate(
        phaseActive: Bool,
        needsServiceReset: Bool,
        recoveryInProgress: Bool,
        action: FreshInstallRecoveryAction
    ) -> FreshInstallRecoveryPlan? {
        guard !recoveryInProgress,
              phaseActive || needsServiceReset else { return nil }
        return FreshInstallRecoveryPlan(
            unregister: BackgroundServiceDescriptor.bundledOwners.map(\.plistName),
            retryAfterUnregistration: action == .retry
        )
    }
}

final class ServiceActionRecorder: PersistentServiceMutating, Encodable {
    private(set) var register: [String] = []
    private(set) var unregister: [String] = []
    let persistentFileWrites: [String] = []

    func register(_ service: BackgroundServiceDescriptor) {
        register.append(service.plistName)
    }

    func unregister(_ service: BackgroundServiceDescriptor) {
        unregister.append(service.plistName)
    }
}

struct MigrationServiceAction: Decodable {
    let action: String
    let transactionId: String
    let nonce: String
    let services: [String]

    func apply(policy: LaunchPolicy, registrar: PersistentServiceMutating) -> Bool {
        guard policy.persistentRegistrationAllowed,
              !transactionId.isEmpty,
              !nonce.isEmpty,
              services == BackgroundServiceDescriptor.bundledOwners.map(\.plistName) else {
            return false
        }
        switch action {
        case "register_services":
            for service in BackgroundServiceDescriptor.bundledOwners {
                registrar.register(service)
            }
        case "unregister_services":
            for service in BackgroundServiceDescriptor.bundledOwners {
                registrar.unregister(service)
            }
        default:
            return false
        }
        return true
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

enum ProductSigningPolicy {
    static let teamIdentifier = "WMU9678ZQL"
    static let applicationIdentifier = "com.yulu.app"
    static let hostIdentifier = "node"
    static let captureIdentifier = "com.yulu.audiodaemon"

    static var allowDevelopmentAdHoc: Bool {
        #if YULU_DEVELOPMENT_SMOKE
        true
        #else
        false
        #endif
    }
}

enum ApplicationRuntimeContract {
    static let hostIPCVersion = 1
    static let captureIPCVersion = 1
    static let hostDatabaseSchemaVersion = 1
    static let hostDatabaseMinimumReadableVersion = 1
}

struct CodeIdentityEvidence: Encodable {
    let accepted: Bool
    let identifier: String
    let teamIdentifier: String
    let cdHash: String
    let staticSealValid: Bool
    let dynamicValid: Bool
    let staticDynamicMatch: Bool

    var dictionary: [String: Any] {
        [
            "accepted": accepted,
            "identifier": identifier,
            "teamIdentifier": teamIdentifier,
            "cdHash": cdHash,
            "staticSealValid": staticSealValid,
            "dynamicValid": dynamicValid,
            "staticDynamicMatch": staticDynamicMatch,
        ]
    }
}

private struct SigningInformation {
    let identifier: String
    let teamIdentifier: String?
    let cdHash: Data
}

private func signingInformation(_ code: SecStaticCode) -> SigningInformation? {
    var raw: CFDictionary?
    guard SecCodeCopySigningInformation(
        code,
        SecCSFlags(rawValue: kSecCSSigningInformation),
        &raw
    ) == errSecSuccess,
    let information = raw as? [String: Any],
    let identifier = information[kSecCodeInfoIdentifier as String] as? String,
    let cdHash = information[kSecCodeInfoUnique as String] as? Data,
    !identifier.isEmpty,
    !cdHash.isEmpty else { return nil }
    return SigningInformation(
        identifier: identifier,
        teamIdentifier: information[kSecCodeInfoTeamIdentifier as String] as? String,
        cdHash: cdHash
    )
}

private func codeRequirement(
    identifier: String,
    teamIdentifier: String,
    allowAdHoc: Bool
) -> SecRequirement? {
    let escapedIdentifier = identifier.replacingOccurrences(of: "\"", with: "\\\"")
    let requirementText: String
    if allowAdHoc {
        requirementText = "identifier \"\(escapedIdentifier)\""
    } else {
        let escapedTeam = teamIdentifier.replacingOccurrences(of: "\"", with: "\\\"")
        requirementText = "anchor apple generic and identifier \"\(escapedIdentifier)\" and certificate leaf[subject.OU] = \"\(escapedTeam)\""
    }
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(
        requirementText as CFString,
        SecCSFlags(),
        &requirement
    ) == errSecSuccess else { return nil }
    return requirement
}

func codeIdentityEvidence(
    pid: Int,
    staticURL: URL,
    expectedIdentifier: String,
    expectedTeamIdentifier: String,
    allowAdHoc: Bool = false
) -> CodeIdentityEvidence? {
    guard pid > 1 else { return nil }
    let requirement = allowAdHoc
        ? nil
        : codeRequirement(
            identifier: expectedIdentifier,
            teamIdentifier: expectedTeamIdentifier,
            allowAdHoc: false
        )
    if !allowAdHoc && requirement == nil { return nil }
    var dynamicCode: SecCode?
    let dynamicStatus: OSStatus
    if pid == Int(getpid()) {
        dynamicStatus = SecCodeCopySelf(SecCSFlags(), &dynamicCode)
    } else {
        dynamicStatus = SecCodeCopyGuestWithAttributes(
            nil,
            [kSecGuestAttributePid as String: pid] as CFDictionary,
            SecCSFlags(),
            &dynamicCode
        )
    }
    guard dynamicStatus == errSecSuccess, let dynamicCode else { return nil }
    var expectedStaticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(
        staticURL as CFURL,
        SecCSFlags(),
        &expectedStaticCode
    ) == errSecSuccess,
    let expectedStaticCode else { return nil }
    let strictFlags = SecCSFlags(
        rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures
    )
    let staticValid = SecStaticCodeCheckValidity(
        expectedStaticCode,
        strictFlags,
        requirement
    ) == errSecSuccess
    let dynamicValid = SecCodeCheckValidity(
        dynamicCode,
        SecCSFlags(),
        requirement
    ) == errSecSuccess
    var dynamicStaticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(
        dynamicCode,
        SecCSFlags(),
        &dynamicStaticCode
    ) == errSecSuccess,
    let dynamicStaticCode,
    let expectedInformation = signingInformation(expectedStaticCode),
    let dynamicInformation = signingInformation(dynamicStaticCode) else { return nil }
    let normalizedTeam = expectedInformation.teamIdentifier ?? (allowAdHoc ? "adhoc" : "")
    let identifiersMatch = expectedInformation.identifier == expectedIdentifier
        && dynamicInformation.identifier == expectedIdentifier
    let teamsMatch = allowAdHoc
        ? expectedInformation.teamIdentifier == nil && dynamicInformation.teamIdentifier == nil
        : expectedInformation.teamIdentifier == expectedTeamIdentifier
            && dynamicInformation.teamIdentifier == expectedTeamIdentifier
    let hashesMatch = expectedInformation.cdHash == dynamicInformation.cdHash
    let accepted = staticValid && dynamicValid && identifiersMatch && teamsMatch && hashesMatch
    return CodeIdentityEvidence(
        accepted: accepted,
        identifier: expectedInformation.identifier,
        teamIdentifier: normalizedTeam,
        cdHash: expectedInformation.cdHash.map { String(format: "%02x", $0) }.joined(),
        staticSealValid: staticValid,
        dynamicValid: dynamicValid,
        staticDynamicMatch: hashesMatch
    )
}

struct RuntimeDatabaseEvidence {
    let status: String
    let quickCheck: String
    let schemaVersion: Int
    let minimumReadableVersion: Int
}

struct RuntimeOwnerEvidence: Encodable {
    let running: Bool
    let capabilityReady: Bool?
    let ownerPID: Int?
    var codeIdentity: CodeIdentityEvidence? = nil
    var productVersion: String? = nil
    var bundleVersion: String? = nil
    var ipcVersion: Int? = nil
    var database: RuntimeDatabaseEvidence? = nil
    var ownerUID: Int? = nil
    var generation: String? = nil
    var executablePath: String? = nil
    var authorityToken: String? = nil
    var instanceNonce: String? = nil

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
              attestation.ownerUID == Int(geteuid()),
              let executablePath = attestation.executablePath,
              !executablePath.isEmpty,
              let processGeneration = attestation.generation,
              !processGeneration.isEmpty else {
            return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
        }
        if kind == "host" {
            guard let authorityToken = attestation.authorityToken,
                  !authorityToken.isEmpty,
                  payload["instanceLockToken"] as? String == authorityToken,
                  let instanceNonce = payload["instanceNonce"] as? String,
                  !instanceNonce.isEmpty else {
                return RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
            }
            let healthy = payload["status"] as? String == "ok"
            return RuntimeOwnerEvidence(
                running: healthy,
                capabilityReady: nil,
                ownerPID: healthy ? pid : nil,
                codeIdentity: healthy ? attestation.codeIdentity : nil,
                productVersion: payload["productVersion"] as? String,
                bundleVersion: payload["bundleVersion"] as? String,
                ipcVersion: payload["hostIPCVersion"] as? Int,
                database: (payload["database"] as? [String: Any]).flatMap { database in
                    guard let status = database["status"] as? String,
                          let quickCheck = database["quickCheck"] as? String,
                          let schemaVersion = database["schemaVersion"] as? Int,
                          let minimumReadableVersion = database["minimumReadableVersion"] as? Int else {
                        return nil
                    }
                    return RuntimeDatabaseEvidence(
                        status: status,
                        quickCheck: quickCheck,
                        schemaVersion: schemaVersion,
                        minimumReadableVersion: minimumReadableVersion
                    )
                },
                ownerUID: attestation.ownerUID,
                generation: processGeneration,
                executablePath: executablePath,
                authorityToken: authorityToken,
                instanceNonce: instanceNonce
            )
        }
        return RuntimeOwnerEvidence(
            running: true,
            capabilityReady: payload["micReady"] as? Bool == true
                && payload["sysReady"] as? Bool == true,
            ownerPID: pid,
            codeIdentity: attestation.codeIdentity,
            productVersion: payload["productVersion"] as? String,
            bundleVersion: payload["bundleVersion"] as? String,
            ipcVersion: payload["captureIPCVersion"] as? Int,
            ownerUID: attestation.ownerUID,
            generation: processGeneration,
            executablePath: executablePath
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
    var codeIdentity: CodeIdentityEvidence? = nil
    var ownerUID: Int? = nil
    var executablePath: String? = nil

    enum CodingKeys: String, CodingKey {
        case ownerPID, authorityToken, generation
        case executableMatches, argumentsMatch, generationStable
        case ownerUID, executablePath
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(ownerPID, forKey: .ownerPID)
        try container.encodeIfPresent(authorityToken, forKey: .authorityToken)
        try container.encodeIfPresent(generation, forKey: .generation)
        try container.encode(executableMatches, forKey: .executableMatches)
        try container.encode(argumentsMatch, forKey: .argumentsMatch)
        try container.encode(generationStable, forKey: .generationStable)
        try container.encodeIfPresent(ownerUID, forKey: .ownerUID)
        try container.encodeIfPresent(executablePath, forKey: .executablePath)
    }

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
            generationStable: generationStable,
            ownerUID: payload["ownerUID"] as? Int,
            executablePath: payload["executablePath"] as? String
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

final class BackgroundServiceRegistry: PersistentServiceMutating {
    private(set) var registrationErrors: [String: String] = [:]

    func registerBundledOwners(policy: LaunchPolicy) {
        guard policy.persistentRegistrationAllowed else { return }
        for descriptor in BackgroundServiceDescriptor.bundledOwners {
            let service = SMAppService.agent(plistName: descriptor.plistName)
            guard service.status == .notRegistered || service.status == .notFound else { continue }
            do {
                try service.register()
                registrationErrors.removeValue(forKey: descriptor.plistName)
            } catch {
                registrationErrors[descriptor.plistName] = error.localizedDescription
            }
        }
    }

    func register(_ descriptor: BackgroundServiceDescriptor) {
        let service = SMAppService.agent(plistName: descriptor.plistName)
        guard service.status == .notRegistered || service.status == .notFound else { return }
        do {
            try service.register()
            registrationErrors.removeValue(forKey: descriptor.plistName)
        } catch {
            registrationErrors[descriptor.plistName] = error.localizedDescription
        }
    }

    func unregister(_ descriptor: BackgroundServiceDescriptor) {
        let service = SMAppService.agent(plistName: descriptor.plistName)
        guard service.status != .notRegistered, service.status != .notFound else { return }
        do {
            try service.unregister()
            registrationErrors.removeValue(forKey: descriptor.plistName)
        } catch {
            registrationErrors[descriptor.plistName] = error.localizedDescription
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

    var applicationExecutable: URL {
        executableDir.appendingPathComponent("yulu_app")
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

struct ApplicationUpdateConfiguration: Encodable {
    let enabled: Bool
    let automaticChecks: Bool
    let explicitInstallOnly: Bool
    let reason: String?

    enum CodingKeys: String, CodingKey {
        case enabled, automaticChecks, explicitInstallOnly, reason
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(enabled, forKey: .enabled)
        try container.encode(automaticChecks, forKey: .automaticChecks)
        try container.encode(explicitInstallOnly, forKey: .explicitInstallOnly)
        if let reason {
            try container.encode(reason, forKey: .reason)
        } else {
            try container.encodeNil(forKey: .reason)
        }
    }

    static func evaluate(info: [String: Any]) -> ApplicationUpdateConfiguration {
        guard let feed = info["SUFeedURL"] as? String,
              let feedURL = URL(string: feed),
              feedURL.scheme?.lowercased() == "https",
              feedURL.host?.isEmpty == false,
              feedURL.user == nil,
              feedURL.password == nil,
              feedURL.fragment == nil else {
            return disabled("Sparkle feed configuration is missing or unsafe.")
        }
        guard let encodedKey = info["SUPublicEDKey"] as? String,
              Data(base64Encoded: encodedKey)?.count == 32 else {
            return disabled("Sparkle public key configuration is missing or invalid.")
        }
        guard info["SUVerifyUpdateBeforeExtraction"] as? Bool == true,
              info["SURequireSignedFeed"] as? Bool == true else {
            return disabled("Sparkle signature verification must fail closed.")
        }
        guard let signedFeedExpiration = info["SUSignedFeedFailureExpirationInterval"] as? NSNumber,
              CFGetTypeID(signedFeedExpiration) != CFBooleanGetTypeID(),
              !["f", "d"].contains(String(cString: signedFeedExpiration.objCType)),
              signedFeedExpiration.int64Value == 0 else {
            return disabled("Sparkle signed-feed failures must never expire.")
        }
        guard info["SUEnableAutomaticChecks"] as? Bool == true,
              info["SUAllowsAutomaticUpdates"] as? Bool == false,
              info["SUAutomaticallyUpdate"] as? Bool == false else {
            return disabled("Yulu updates require automatic checks and explicit installation.")
        }
        return ApplicationUpdateConfiguration(
            enabled: true,
            automaticChecks: true,
            explicitInstallOnly: true,
            reason: nil
        )
    }

    private static func disabled(_ reason: String) -> ApplicationUpdateConfiguration {
        ApplicationUpdateConfiguration(
            enabled: false,
            automaticChecks: false,
            explicitInstallOnly: true,
            reason: reason
        )
    }
}

struct UpdateTerminationGate: Encodable {
    let allowTermination: Bool

    static func evaluate(
        updatePending: Bool,
        installAuthorized: Bool,
        rollbackHelperLaunched: Bool
    ) -> UpdateTerminationGate {
        UpdateTerminationGate(
            allowTermination: allowTermination(
                updatePending: updatePending,
                installAuthorized: installAuthorized,
                rollbackHelperLaunched: rollbackHelperLaunched
            )
        )
    }

    static func allowTermination(
        updatePending: Bool,
        installAuthorized: Bool,
        rollbackHelperLaunched: Bool
    ) -> Bool {
        !updatePending || installAuthorized || rollbackHelperLaunched
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
        environment["YULU_PRODUCT_VERSION"] = Bundle.main.object(
            forInfoDictionaryKey: "YuluReleaseVersion"
        ) as? String ?? ""
        environment["YULU_BUNDLE_VERSION"] = Bundle.main.object(
            forInfoDictionaryKey: "CFBundleVersion"
        ) as? String ?? ""
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

struct ApplicationMigrationCommand: Encodable {
    let executableURL: URL
    let arguments: [String]

    enum CodingKeys: String, CodingKey {
        case executable, arguments
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(executableURL.path, forKey: .executable)
        try container.encode(arguments, forKey: .arguments)
    }

    static func make(
        policy: LaunchPolicy,
        layout: BundleLayout,
        applicationPaths: ApplicationDataPaths,
        homeDirectory: URL,
        requestRetry: Bool = false
    ) -> ApplicationMigrationCommand? {
        guard policy.persistentRegistrationAllowed else { return nil }
        let migrationScript = layout.bundledScriptDir
            .appendingPathComponent("application_migration.py")
        let migrationRoot = applicationPaths.durableDataDir
            .appendingPathComponent("application-migration", isDirectory: true)
        var arguments = [
                "-B",
                migrationScript.path,
                "session",
                "--home", homeDirectory.path,
                "--durable", applicationPaths.durableDataDir.path,
                "--cache", applicationPaths.cacheDir.path,
                "--legacy", applicationPaths.legacyReadOnlyDataDir.path,
                "--launch-agents", homeDirectory
                    .appendingPathComponent("Library/LaunchAgents", isDirectory: true).path,
                "--archive", migrationRoot
                    .appendingPathComponent("rollback/LaunchAgents", isDirectory: true).path,
                "--capture-socket", applicationPaths.legacyReadOnlyDataDir
                    .appendingPathComponent("audio_daemon.sock").path,
                "--node", layout.hostNode.path,
                "--server", layout.hostEntry.path,
                "--app", layout.bundleURL.path,
            ]
        #if YULU_DEVELOPMENT_SMOKE
        arguments.append("--allow-development-adhoc")
        #endif
        if requestRetry { arguments.append("--request-retry") }
        return ApplicationMigrationCommand(
            executableURL: layout.bundledPython,
            arguments: arguments
        )
    }
}

struct ApplicationUpdateCommand: Encodable {
    let executableURL: URL
    let arguments: [String]

    enum CodingKeys: String, CodingKey {
        case executable, arguments
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(executableURL.path, forKey: .executable)
        try container.encode(arguments, forKey: .arguments)
    }

    static func make(
        policy: LaunchPolicy,
        layout: BundleLayout,
        applicationPaths: ApplicationDataPaths,
        currentVersion: String,
        currentBuild: String,
        targetVersion: String? = nil,
        targetBuild: String? = nil,
        requestRollback: Bool = false
    ) -> ApplicationUpdateCommand? {
        guard policy.persistentRegistrationAllowed,
              !currentVersion.isEmpty,
              !currentBuild.isEmpty,
              (targetVersion == nil) == (targetBuild == nil) else { return nil }
        let script = layout.bundledScriptDir.appendingPathComponent("application_update.py")
        let databaseRoot = applicationPaths.durableDataDir
        var arguments = [
            "-B",
            script.path,
            "session",
            "--durable", applicationPaths.durableDataDir.path,
            "--cache", applicationPaths.cacheDir.path,
            "--application", layout.bundleURL.path,
            "--current-version", currentVersion,
            "--current-build", currentBuild,
            "--host-database", databaseRoot.appendingPathComponent("host.sqlite").path,
            "--prompts-database", databaseRoot.appendingPathComponent("prompts.sqlite").path,
            "--vocab-database", databaseRoot.appendingPathComponent("vocab.sqlite").path,
            "--search-database", databaseRoot.appendingPathComponent("search.sqlite").path,
        ]
        if let targetVersion, let targetBuild {
            arguments += [
                "--target-version", targetVersion,
                "--target-build", targetBuild,
            ]
        }
        if requestRollback { arguments.append("--request-rollback") }
        return ApplicationUpdateCommand(
            executableURL: layout.bundledPython,
            arguments: arguments
        )
    }
}

struct ApplicationMigrationAction: Decodable {
    let action: String
    let transactionId: String?
    let nonce: String?
    let services: [String]?
    let deadlineAt: String?
    let detail: String?
}

final class BoundedRedactedStderrDrain {
    private static let maximumBufferedBytes = 4 * 1024
    private let lock = NSLock()
    private let reachedEOF = DispatchSemaphore(value: 0)
    private weak var handle: FileHandle?
    private var redactedBuffer = Data()
    private var didReachEOF = false
    private var didTruncate = false

    func start(_ handle: FileHandle) {
        self.handle = handle
        handle.readabilityHandler = { [weak self] readable in
            guard let self else { return }
            let data = readable.availableData
            if data.isEmpty {
                self.lock.lock()
                if !self.didReachEOF {
                    self.didReachEOF = true
                    self.reachedEOF.signal()
                }
                self.lock.unlock()
                readable.readabilityHandler = nil
                return
            }
            self.lock.lock()
            let remaining = max(
                0,
                Self.maximumBufferedBytes - self.redactedBuffer.count
            )
            let retained = min(remaining, data.count)
            if retained > 0 {
                self.redactedBuffer.append(
                    Data(repeating: 0x23, count: retained)
                )
            }
            if retained < data.count {
                self.didTruncate = true
            }
            self.lock.unlock()
        }
    }

    func finishAfterProcessExit() {
        _ = reachedEOF.wait(timeout: .now() + 1)
        handle?.readabilityHandler = nil
        handle = nil
    }

    var hadOutput: Bool {
        lock.lock()
        defer { lock.unlock() }
        return !redactedBuffer.isEmpty
    }

    var truncated: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didTruncate
    }

    var userFacingDetail: String? {
        lock.lock()
        defer { lock.unlock() }
        guard !redactedBuffer.isEmpty else { return nil }
        return didTruncate
            ? "Migration authority emitted redacted diagnostic output (truncated)."
            : "Migration authority emitted redacted diagnostic output."
    }
}

final class ApplicationMigrationCoordinator {
    private enum FreshInstallPhase {
        case inactive
        case registering
        case awaitingApproval
        case awaitingHealth
        case registrationBlocked
        case healthBlocked
        case cancelling
    }

    private let policy: LaunchPolicy
    private let layout: BundleLayout
    private let applicationPaths: ApplicationDataPaths
    private let homeDirectory: URL
    private let services: BackgroundServiceRegistry
    private var migrationProcess: Process?
    private var migrationInput: FileHandle?
    private var migrationOutputBuffer = Data()
    private var migrationTerminalSeen = false
    private var currentBinding: (transactionId: String, nonce: String)?
    private var pendingHealth: (transactionId: String, nonce: String)?
    private var retryAvailable = false
    private var retryAfterProcessExit = false
    private var freshInstallPhase = FreshInstallPhase.inactive
    private var freshInstallHealthGeneration = 0
    private var freshInstallHostReady = false
    private var freshInstallCaptureReady = false
    private var freshInstallNeedsServiceReset = false

    var onStateChange: ((String, String?) -> Void)?
    var onNeedsHealth: (() -> Void)?

    init(
        policy: LaunchPolicy,
        layout: BundleLayout,
        applicationPaths: ApplicationDataPaths,
        homeDirectory: URL,
        services: BackgroundServiceRegistry
    ) {
        self.policy = policy
        self.layout = layout
        self.applicationPaths = applicationPaths
        self.homeDirectory = homeDirectory
        self.services = services
    }

    func advance(event: String? = nil, observation: [String: Any]? = nil) {
        if migrationProcess == nil {
            guard event == nil, observation == nil else { return }
            startSession()
            return
        }
        guard let binding = currentBinding else { return }
        var envelope: [String: Any] = [
            "transactionId": binding.transactionId,
            "nonce": binding.nonce,
        ]
        if let event {
            envelope["event"] = event
        } else if let observation {
            envelope["observation"] = observation
        } else {
            return
        }
        guard let encoded = try? JSONSerialization.data(withJSONObject: envelope),
              encoded.count <= 64 * 1024,
              let migrationInput else {
            self.migrationInput?.closeFile()
            self.migrationInput = nil
            onStateChange?("blocked", "Migration session message was invalid.")
            return
        }
        do {
            try migrationInput.write(contentsOf: encoded + Data("\n".utf8))
        } catch {
            migrationInput.closeFile()
            self.migrationInput = nil
        }
    }

    func retry() {
        guard retryAvailable else { return }
        retryAvailable = false
        pendingHealth = nil
        if beginFreshInstallRecovery(action: .retry) { return }
        freshInstallPhase = .inactive
        if migrationProcess != nil {
            retryAfterProcessExit = true
            migrationInput?.closeFile()
            migrationInput = nil
            return
        }
        startSession(requestRetry: true)
    }

    private func startSession(requestRetry: Bool = false) {
        guard migrationProcess == nil else { return }
        guard let command = ApplicationMigrationCommand.make(
                policy: policy,
                layout: layout,
                applicationPaths: applicationPaths,
                homeDirectory: homeDirectory,
                requestRetry: requestRetry
              ) else { return }
        retryAfterProcessExit = false
        migrationTerminalSeen = false
        migrationOutputBuffer.removeAll(keepingCapacity: true)
        currentBinding = nil
        let input = Pipe()
        let output = Pipe()
        let errors = Pipe()
        let process = Process()
        process.executableURL = command.executableURL
        process.arguments = command.arguments
        var environment = sanitizedRuntimeEnvironment()
        environment.merge(applicationPaths.environment) { _, contract in contract }
        environment["HOME"] = homeDirectory.path
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PATH"] = "\(layout.bundledPythonBin.path):/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment
        process.currentDirectoryURL = layout.bundledScriptDir
        process.standardInput = input
        process.standardOutput = output
        process.standardError = errors
        let stderrDrain = BoundedRedactedStderrDrain()
        stderrDrain.start(errors.fileHandleForReading)
        migrationProcess = process
        migrationInput = input.fileHandleForWriting
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                self?.consumeSessionOutput(data)
            }
        }
        process.terminationHandler = { [weak self] process in
            stderrDrain.finishAfterProcessExit()
            let errorDetail = stderrDrain.userFacingDetail
            DispatchQueue.main.async {
                guard let self else { return }
                output.fileHandleForReading.readabilityHandler = nil
                self.migrationProcess = nil
                self.migrationInput = nil
                self.currentBinding = nil
                let shouldRetry = self.retryAfterProcessExit
                self.retryAfterProcessExit = false
                if shouldRetry {
                    self.startSession(requestRetry: true)
                } else if !self.migrationTerminalSeen {
                    self.onStateChange?(
                        "blocked",
                        errorDetail != nil
                            ? errorDetail
                            : "Migration authority exited before a terminal state."
                    )
                }
            }
        }
        do {
            try process.run()
            errors.fileHandleForWriting.closeFile()
        } catch {
            errors.fileHandleForWriting.closeFile()
            stderrDrain.finishAfterProcessExit()
            migrationProcess = nil
            migrationInput = nil
            onStateChange?("blocked", error.localizedDescription)
        }
    }

    private func consumeSessionOutput(_ data: Data) {
        migrationOutputBuffer.append(data)
        if migrationOutputBuffer.count > 64 * 1024,
           !migrationOutputBuffer.contains(0x0A) {
            migrationInput?.closeFile()
            migrationInput = nil
            return
        }
        while let newline = migrationOutputBuffer.firstIndex(of: 0x0A) {
            let line = migrationOutputBuffer[..<newline]
            migrationOutputBuffer.removeSubrange(...newline)
            guard line.count <= 64 * 1024,
                  let action = try? JSONDecoder().decode(
                    ApplicationMigrationAction.self,
                    from: Data(line)
                  ) else {
                migrationInput?.closeFile()
                migrationInput = nil
                return
            }
            if let transactionId = action.transactionId, let nonce = action.nonce {
                currentBinding = (transactionId, nonce)
            }
            handle(action)
        }
    }

    func cancel() {
        if freshInstallPhase == .cancelling { return }
        if beginFreshInstallRecovery(action: .cancel) { return }
        advance(event: "cancel")
    }

    @discardableResult
    private func beginFreshInstallRecovery(action: FreshInstallRecoveryAction) -> Bool {
        guard let plan = FreshInstallRecoveryPlan.evaluate(
            phaseActive: freshInstallPhase != .inactive,
            needsServiceReset: freshInstallNeedsServiceReset,
            recoveryInProgress: freshInstallPhase == .cancelling,
            action: action
        ) else { return false }
        retryAvailable = false
        freshInstallNeedsServiceReset = false
        freshInstallPhase = .cancelling
        onStateChange?("cancelling", action.rawValue)
        for plistName in plan.unregister {
            guard let service = BackgroundServiceDescriptor.bundledOwners.first(
                where: { $0.plistName == plistName }
            ) else { continue }
            services.unregister(service)
        }
        observeFreshInstallCancellation(
            attempt: 0,
            retryAfterUnregistration: plan.retryAfterUnregistration
        )
        return true
    }

    func submitHealth(host: RuntimeOwnerEvidence, capture: RuntimeOwnerEvidence) {
        if freshInstallPhase == .awaitingHealth {
            freshInstallHostReady = runtimeOwnerIsReady(host)
            freshInstallCaptureReady = runtimeOwnerIsReady(capture)
            if FreshInstallHealthDisposition.evaluate(
                hostReady: freshInstallHostReady,
                captureReady: freshInstallCaptureReady,
                timedOut: false
            ) == .committed {
                freshInstallPhase = .inactive
                freshInstallNeedsServiceReset = false
                onStateChange?("committed", nil)
            }
            return
        }
        guard let pendingHealth,
              host.running,
              capture.running,
              let hostPID = host.ownerPID,
              let capturePID = capture.ownerPID,
              let hostCodeIdentity = host.codeIdentity,
              hostCodeIdentity.accepted,
              let captureCodeIdentity = capture.codeIdentity,
              captureCodeIdentity.accepted,
              let applicationCodeIdentity = codeIdentityEvidence(
                pid: Int(getpid()),
                staticURL: layout.bundleURL,
                expectedIdentifier: ProductSigningPolicy.applicationIdentifier,
                expectedTeamIdentifier: ProductSigningPolicy.teamIdentifier,
                allowAdHoc: ProductSigningPolicy.allowDevelopmentAdHoc
              ),
              applicationCodeIdentity.accepted else { return }
        self.pendingHealth = nil
        advance(observation: [
            "kind": "health",
            "transactionId": pendingHealth.transactionId,
            "nonce": pendingHealth.nonce,
            "app": [
                "installed": policy.installed,
                "bundlePath": layout.bundleURL.standardizedFileURL
                    .resolvingSymlinksInPath().path,
                "executablePath": layout.bundleURL
                    .appendingPathComponent("Contents/MacOS/yulu_app")
                    .standardizedFileURL.resolvingSymlinksInPath().path,
                "codeIdentity": applicationCodeIdentity.dictionary,
            ],
            "host": [
                "running": true,
                "ownerPID": hostPID,
                "port": HostServiceExecution.declaredPort,
                "codeIdentity": hostCodeIdentity.dictionary,
            ],
            "capture": [
                "running": true,
                "ownerPID": capturePID,
                "socketOwned": true,
                "codeIdentity": captureCodeIdentity.dictionary,
            ],
        ])
    }

    private func handle(_ action: ApplicationMigrationAction) {
        switch action.action {
        case "register_services", "unregister_services":
            guard let transactionId = action.transactionId,
                  let nonce = action.nonce,
                  let serviceNames = action.services else {
                onStateChange?("blocked", "Migration service action was not transaction-bound.")
                return
            }
            let serviceAction = MigrationServiceAction(
                action: action.action,
                transactionId: transactionId,
                nonce: nonce,
                services: serviceNames
            )
            guard serviceAction.apply(policy: policy, registrar: services) else {
                onStateChange?("blocked", "Migration service action was rejected.")
                return
            }
            observeServiceAction(serviceAction, attempt: 0)
        case "observe_services":
            guard let transactionId = action.transactionId,
                  let nonce = action.nonce else {
                onStateChange?("blocked", "Migration observation was not transaction-bound.")
                return
            }
            observeServiceAction(
                MigrationServiceAction(
                    action: "observe_services",
                    transactionId: transactionId,
                    nonce: nonce,
                    services: BackgroundServiceDescriptor.bundledOwners.map(\.plistName)
                ),
                attempt: 0
            )
        case "await_approval":
            onStateChange?("awaiting_approval", action.deadlineAt)
            if let raw = action.deadlineAt,
               let deadline = ISO8601DateFormatter().date(from: raw) {
                DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSinceNow)) { [weak self] in
                    self?.advance(event: "resume")
                }
            }
        case "verify_health":
            guard let transactionId = action.transactionId,
                  let nonce = action.nonce else {
                onStateChange?("blocked", "Health verification was not transaction-bound.")
                return
            }
            pendingHealth = (transactionId, nonce)
            onStateChange?("verifying", nil)
            onNeedsHealth?()
        case "fresh_install":
            migrationTerminalSeen = true
            retryAvailable = false
            freshInstallPhase = .registering
            onStateChange?("registering", nil)
            services.registerBundledOwners(policy: policy)
            observeFreshInstallRegistration(attempt: 0)
        case "committed":
            migrationTerminalSeen = true
            retryAvailable = false
            pendingHealth = nil
            onStateChange?("committed", nil)
        case "rolled_back":
            migrationTerminalSeen = true
            retryAvailable = true
            pendingHealth = nil
            onStateChange?("rolled_back", nil)
        case "blocked":
            migrationTerminalSeen = true
            retryAvailable = false
            onStateChange?("blocked", action.detail)
        case "busy":
            migrationTerminalSeen = true
            retryAvailable = false
            onStateChange?("busy", "Another Yulu migration attempt is active.")
        default:
            onStateChange?("blocked", "Unknown migration action: \(action.action)")
        }
    }

    private func observeFreshInstallRegistration(attempt: Int) {
        guard freshInstallPhase == .registering
                || freshInstallPhase == .awaitingApproval else { return }
        let statuses = services.statuses()
        let values = BackgroundServiceDescriptor.bundledOwners.map {
            statuses[$0.plistName] ?? "notFound"
        }
        switch FreshInstallRegistrationDisposition.evaluate(
            statuses: values,
            attempt: attempt
        ) {
        case .verifyHealth:
            freshInstallPhase = .awaitingHealth
            freshInstallHostReady = false
            freshInstallCaptureReady = false
            freshInstallHealthGeneration += 1
            let generation = freshInstallHealthGeneration
            onStateChange?("verifying", nil)
            onNeedsHealth?()
            DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
                self?.freshInstallHealthTimedOut(generation: generation)
            }
        case .awaitingApproval:
            if freshInstallPhase != .awaitingApproval {
                freshInstallPhase = .awaitingApproval
                onStateChange?("awaiting_approval", nil)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.observeFreshInstallRegistration(attempt: attempt)
            }
        case .pending:
            freshInstallPhase = .registering
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.observeFreshInstallRegistration(attempt: attempt + 1)
            }
        case .blocked:
            freshInstallPhase = .registrationBlocked
            retryAvailable = true
            freshInstallNeedsServiceReset = true
            let detail = services.registrationErrors.values.sorted().first
                ?? "Yulu could not register its bundled background services."
            onStateChange?("registration_blocked", detail)
        case nil:
            freshInstallPhase = .registrationBlocked
            retryAvailable = false
            freshInstallNeedsServiceReset = true
            onStateChange?("blocked", "Yulu received an invalid background service state.")
        }
    }

    private func observeFreshInstallCancellation(
        attempt: Int,
        retryAfterUnregistration: Bool
    ) {
        guard freshInstallPhase == .cancelling else { return }
        let statuses = services.statuses()
        let values = BackgroundServiceDescriptor.bundledOwners.map {
            statuses[$0.plistName] ?? "notFound"
        }
        if values.allSatisfy({ $0 == "notRegistered" || $0 == "notFound" }) {
            if retryAfterUnregistration {
                freshInstallPhase = .registering
                onStateChange?("registering", nil)
                services.registerBundledOwners(policy: policy)
                observeFreshInstallRegistration(attempt: 0)
            } else {
                freshInstallPhase = .inactive
                retryAvailable = true
                onStateChange?("fresh_install_cancelled", nil)
            }
            return
        }
        if attempt < 40 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.observeFreshInstallCancellation(
                    attempt: attempt + 1,
                    retryAfterUnregistration: retryAfterUnregistration
                )
            }
            return
        }
        freshInstallPhase = .inactive
        retryAvailable = false
        let detail = services.registrationErrors.values.sorted().first
            ?? "Yulu could not unregister its bundled background services."
        onStateChange?("blocked", detail)
    }

    private func freshInstallHealthTimedOut(generation: Int) {
        guard freshInstallPhase == .awaitingHealth,
              generation == freshInstallHealthGeneration,
              FreshInstallHealthDisposition.evaluate(
                hostReady: freshInstallHostReady,
                captureReady: freshInstallCaptureReady,
                timedOut: true
              ) == .blocked else { return }
        freshInstallPhase = .healthBlocked
        retryAvailable = true
        freshInstallNeedsServiceReset = true
        let component: String
        if !freshInstallHostReady && !freshInstallCaptureReady {
            component = "Host and Capture did not become ready"
        } else if !freshInstallHostReady {
            component = "Host did not become ready"
        } else {
            component = "Capture did not become ready"
        }
        onStateChange?("health_blocked", "\(component) within 30 seconds.")
    }

    private func runtimeOwnerIsReady(_ evidence: RuntimeOwnerEvidence) -> Bool {
        evidence.running
            && evidence.ownerPID != nil
            && evidence.codeIdentity?.accepted == true
    }

    private func observeServiceAction(_ action: MigrationServiceAction, attempt: Int) {
        let statuses = services.statuses()
        let values = BackgroundServiceDescriptor.bundledOwners.map {
            statuses[$0.plistName] ?? "notFound"
        }
        let terminal: Bool
        if action.action == "unregister_services" {
            terminal = values.allSatisfy { $0 == "notRegistered" || $0 == "notFound" }
        } else {
            terminal = values.allSatisfy { $0 == "enabled" || $0 == "requiresApproval" }
        }
        if !terminal && attempt < 40 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.observeServiceAction(action, attempt: attempt + 1)
            }
            return
        }
        advance(observation: [
            "kind": "services",
            "transactionId": action.transactionId,
            "nonce": action.nonce,
            "statuses": statuses,
        ])
    }
}

struct ApplicationUpdateAction: Decodable {
    let action: String
    let scope: String?
    let transactionId: String?
    let nonce: String?
    let services: [String]?
    let target: [String: String]?
    let executable: String?
    let script: String?
    let failure: String?
    let reason: String?
}

func applicationUpdateHealthPayload(
    currentVersion: String,
    currentBuild: String,
    applicationPID: Int,
    applicationUID: Int,
    applicationGeneration: String,
    applicationExecutable: String,
    applicationIdentity: CodeIdentityEvidence,
    host: RuntimeOwnerEvidence,
    capture: RuntimeOwnerEvidence,
    serviceStatuses: [String: String]
) -> [String: Any]? {
    guard applicationIdentity.accepted,
          host.running,
          capture.running,
          let hostPID = host.ownerPID,
          let hostUID = host.ownerUID,
          hostUID == applicationUID,
          let hostGeneration = host.generation,
          let hostExecutable = host.executablePath,
          let hostNonce = host.instanceNonce,
          let hostLockToken = host.authorityToken,
          let hostIdentity = host.codeIdentity,
          hostIdentity.accepted,
          let hostProductVersion = host.productVersion,
          let hostBundleVersion = host.bundleVersion,
          let hostIPCVersion = host.ipcVersion,
          hostIPCVersion == ApplicationRuntimeContract.hostIPCVersion,
          let database = host.database,
          database.status == "ok",
          database.quickCheck == "ok",
          database.schemaVersion == ApplicationRuntimeContract.hostDatabaseSchemaVersion,
          database.minimumReadableVersion
            == ApplicationRuntimeContract.hostDatabaseMinimumReadableVersion,
          let capturePID = capture.ownerPID,
          let captureUID = capture.ownerUID,
          captureUID == applicationUID,
          let captureGeneration = capture.generation,
          let captureExecutable = capture.executablePath,
          let captureIdentity = capture.codeIdentity,
          captureIdentity.accepted,
          let captureProductVersion = capture.productVersion,
          let captureBundleVersion = capture.bundleVersion,
          let captureIPCVersion = capture.ipcVersion,
          captureIPCVersion == ApplicationRuntimeContract.captureIPCVersion else {
        return nil
    }
    return [
        "application": [
            "identifier": applicationIdentity.identifier,
            "teamIdentifier": applicationIdentity.teamIdentifier,
            "cdHash": applicationIdentity.cdHash,
            "version": currentVersion,
            "build": currentBuild,
            "pid": applicationPID,
            "uid": applicationUID,
            "generation": applicationGeneration,
            "executable": applicationExecutable,
        ],
        "host": [
            "identifier": hostIdentity.identifier,
            "teamIdentifier": hostIdentity.teamIdentifier,
            "cdHash": hostIdentity.cdHash,
            "productVersion": hostProductVersion,
            "bundleVersion": hostBundleVersion,
            "hostIPCVersion": hostIPCVersion,
            "serviceOwner": "com.yulu.ui",
            "pid": hostPID,
            "uid": hostUID,
            "generation": hostGeneration,
            "executable": hostExecutable,
            "hostNonce": hostNonce,
            "instanceLockToken": hostLockToken,
            "portOwnerPID": hostPID,
            "database": [
                "status": database.status,
                "quickCheck": database.quickCheck,
                "schemaVersion": database.schemaVersion,
                "minimumReadableVersion": database.minimumReadableVersion,
            ],
        ],
        "capture": [
            "identifier": captureIdentity.identifier,
            "teamIdentifier": captureIdentity.teamIdentifier,
            "cdHash": captureIdentity.cdHash,
            "productVersion": captureProductVersion,
            "bundleVersion": captureBundleVersion,
            "captureIPCVersion": captureIPCVersion,
            "serviceOwner": "com.yulu.audiodaemon",
            "pid": capturePID,
            "uid": captureUID,
            "generation": captureGeneration,
            "executable": captureExecutable,
            "socketOwnerPID": capturePID,
        ],
        "services": serviceStatuses,
    ]
}

final class ApplicationUpdateCoordinator {
    private let policy: LaunchPolicy
    private let layout: BundleLayout
    private let applicationPaths: ApplicationDataPaths
    private let services: BackgroundServiceRegistry
    private let currentVersion: String
    private let currentBuild: String
    private var process: Process?
    private var input: FileHandle?
    private var outputBuffer = Data()
    private var terminalSeen = false
    private var binding: (transactionId: String, nonce: String)?
    private var retainedInstallHandler: (() -> Void)?
    private var deferredTarget: (version: String, build: String)?
    private var sessionGeneration = 0
    private var startMigrationAfterTermination = false

    private(set) var updatePending = false
    private(set) var installAuthorized = false
    private(set) var rollbackHelperLaunched = false

    var onStateChange: ((String, String?) -> Void)?
    var onCanStartMigration: (() -> Void)?
    var onNeedsHealth: (() -> Void)?
    var currentHealth: (() -> (host: RuntimeOwnerEvidence, capture: RuntimeOwnerEvidence))?
    var onRollbackHelperLaunched: (() -> Void)?

    init(
        policy: LaunchPolicy,
        layout: BundleLayout,
        applicationPaths: ApplicationDataPaths,
        services: BackgroundServiceRegistry
    ) {
        self.policy = policy
        self.layout = layout
        self.applicationPaths = applicationPaths
        self.services = services
        let info = Bundle.main.infoDictionary ?? [:]
        self.currentVersion = info["YuluReleaseVersion"] as? String ?? ""
        self.currentBuild = info["CFBundleVersion"] as? String ?? ""
    }

    func resume() {
        guard process == nil, retainedInstallHandler == nil else { return }
        startSession(targetVersion: nil, targetBuild: nil, requestRollback: false)
    }

    func prepareInstall(
        targetVersion: String,
        targetBuild: String,
        installHandler: @escaping () -> Void
    ) {
        guard process == nil, retainedInstallHandler == nil else { return }
        retainedInstallHandler = installHandler
        deferredTarget = (targetVersion, targetBuild)
        updatePending = true
        startSession(
            targetVersion: targetVersion,
            targetBuild: targetBuild,
            requestRollback: false
        )
    }

    func requestRollback() {
        guard process == nil else { return }
        updatePending = true
        startSession(targetVersion: nil, targetBuild: nil, requestRollback: true)
    }

    func submitHealth() {
        guard let health = healthPayload() else { return }
        send(["health": health])
    }

    private func startSession(
        targetVersion: String?,
        targetBuild: String?,
        requestRollback: Bool
    ) {
        guard let command = ApplicationUpdateCommand.make(
            policy: policy,
            layout: layout,
            applicationPaths: applicationPaths,
            currentVersion: currentVersion,
            currentBuild: currentBuild,
            targetVersion: targetVersion,
            targetBuild: targetBuild,
            requestRollback: requestRollback
        ) else {
            onStateChange?("blocked", "Application update command is unavailable.")
            return
        }
        sessionGeneration += 1
        let generation = sessionGeneration
        terminalSeen = false
        binding = nil
        outputBuffer.removeAll(keepingCapacity: true)
        let inputPipe = Pipe()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let child = Process()
        child.executableURL = command.executableURL
        child.arguments = command.arguments
        child.standardInput = inputPipe
        child.standardOutput = outputPipe
        child.standardError = errorPipe
        child.currentDirectoryURL = layout.bundledScriptDir
        var environment = sanitizedRuntimeEnvironment()
        environment.merge(applicationPaths.environment) { _, contract in contract }
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        environment["PATH"] = "\(layout.bundledPythonBin.path):/usr/bin:/bin:/usr/sbin:/sbin"
        child.environment = environment
        let stderrDrain = BoundedRedactedStderrDrain()
        stderrDrain.start(errorPipe.fileHandleForReading)
        process = child
        input = inputPipe.fileHandleForWriting
        outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async {
                guard generation == self?.sessionGeneration else { return }
                self?.consume(data)
            }
        }
        child.terminationHandler = { [weak self] _ in
            stderrDrain.finishAfterProcessExit()
            DispatchQueue.main.async {
                guard let self, generation == self.sessionGeneration else { return }
                outputPipe.fileHandleForReading.readabilityHandler = nil
                self.process = nil
                self.input = nil
                self.binding = nil
                if !self.terminalSeen {
                    self.onStateChange?(
                        "blocked",
                        stderrDrain.userFacingDetail
                            ?? "Application update authority exited before a terminal state."
                    )
                } else if self.startMigrationAfterTermination {
                    self.startMigrationAfterTermination = false
                    self.onCanStartMigration?()
                }
            }
        }
        do {
            try child.run()
            errorPipe.fileHandleForWriting.closeFile()
        } catch {
            errorPipe.fileHandleForWriting.closeFile()
            stderrDrain.finishAfterProcessExit()
            process = nil
            input = nil
            onStateChange?("blocked", error.localizedDescription)
        }
    }

    private func send(_ payload: [String: Any], requiresBinding: Bool = true) {
        guard let input else { return }
        var envelope = payload
        if requiresBinding {
            guard let binding else { return }
            envelope["transactionId"] = binding.transactionId
            envelope["nonce"] = binding.nonce
        }
        guard let data = try? JSONSerialization.data(withJSONObject: envelope),
              data.count <= 64 * 1024 else {
            input.closeFile()
            self.input = nil
            return
        }
        do {
            try input.write(contentsOf: data + Data("\n".utf8))
        } catch {
            input.closeFile()
            self.input = nil
        }
    }

    private func consume(_ data: Data) {
        outputBuffer.append(data)
        if outputBuffer.count > 64 * 1024, !outputBuffer.contains(0x0A) {
            input?.closeFile()
            input = nil
            return
        }
        while let newline = outputBuffer.firstIndex(of: 0x0A) {
            let line = outputBuffer[..<newline]
            outputBuffer.removeSubrange(...newline)
            guard line.count <= 64 * 1024,
                  let action = try? JSONDecoder().decode(
                    ApplicationUpdateAction.self,
                    from: Data(line)
                  ) else {
                input?.closeFile()
                input = nil
                return
            }
            if let transactionId = action.transactionId, let nonce = action.nonce {
                binding = (transactionId, nonce)
            }
            handle(action)
        }
    }

    private func handle(_ action: ApplicationUpdateAction) {
        switch action.action {
        case "idle", "committed", "aborted", "rolled_back":
            terminalSeen = true
            updatePending = false
            retainedInstallHandler = nil
            deferredTarget = nil
            onStateChange?(action.action, action.failure)
            startMigrationAfterTermination = true
        case "observe_recording":
            observeRecording(requiresBinding: action.scope == nil)
        case "defer_installation":
            terminalSeen = true
            onStateChange?("deferred", action.reason)
            if retainedInstallHandler != nil {
                scheduleDeferredRecordingProbe()
            } else {
                updatePending = false
                startMigrationAfterTermination = true
            }
        case "unregister_services", "unregister_services_for_rollback":
            guard policy.persistentRegistrationAllowed else {
                onStateChange?("blocked", "Application update service action was rejected.")
                return
            }
            BackgroundServiceDescriptor.bundledOwners.forEach { services.unregister($0) }
            observeQuiescence(attempt: 0)
        case "install_update":
            send(["action": "authorize_install"])
        case "invoke_install_handler":
            terminalSeen = true
            guard let handler = retainedInstallHandler else {
                updatePending = false
                onStateChange?("blocked", "Sparkle install handler is unavailable.")
                return
            }
            retainedInstallHandler = nil
            deferredTarget = nil
            installAuthorized = true
            onStateChange?("installing", nil)
            handler()
        case "register_services":
            guard policy.persistentRegistrationAllowed else {
                onStateChange?("blocked", "Application update service action was rejected.")
                return
            }
            BackgroundServiceDescriptor.bundledOwners.forEach { services.register($0) }
            observeRegistration(attempt: 0)
        case "observe_services":
            onStateChange?("awaiting_approval", nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.observeRegistration(attempt: 0)
            }
        case "verify_update_health", "verify_previous_health":
            onStateChange?("verifying", nil)
            onNeedsHealth?()
            submitHealth()
        case "offer_return_to_previous_application":
            terminalSeen = true
            updatePending = true
            onStateChange?("rollback_offered", action.failure)
        case "launch_rollback_helper":
            terminalSeen = true
            launchRollbackHelper(action)
        case "blocked":
            terminalSeen = true
            updatePending = true
            onStateChange?("blocked", action.failure)
        default:
            input?.closeFile()
            input = nil
        }
    }

    private func observeRecording(requiresBinding: Bool) {
        let socket = applicationPaths.ipcDir.appendingPathComponent("audio_daemon.sock")
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let status = captureRuntimeStatus(
                socketURL: socket,
                expectedExecutable: self.layout.captureExecutable
            )
            DispatchQueue.main.async {
                self.send(
                    ["recording": status.recording ?? NSNull()],
                    requiresBinding: requiresBinding
                )
            }
        }
    }

    private func scheduleDeferredRecordingProbe() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self,
                  self.process == nil,
                  self.retainedInstallHandler != nil,
                  let target = self.deferredTarget else { return }
            let socket = self.applicationPaths.ipcDir
                .appendingPathComponent("audio_daemon.sock")
            DispatchQueue.global(qos: .utility).async { [weak self] in
                guard let self else { return }
                let status = captureRuntimeStatus(
                    socketURL: socket,
                    expectedExecutable: self.layout.captureExecutable
                )
                DispatchQueue.main.async {
                    guard self.process == nil,
                          self.retainedInstallHandler != nil else { return }
                    if status.recording == false {
                        self.startSession(
                            targetVersion: target.version,
                            targetBuild: target.build,
                            requestRollback: false
                        )
                    } else {
                        self.scheduleDeferredRecordingProbe()
                    }
                }
            }
        }
    }

    private func observeQuiescence(attempt: Int) {
        let statuses = services.statuses()
        let host = hostQuiescenceEvidence(
            ownerURL: applicationPaths.durableDataDir.appendingPathComponent(
                "host-instance.lock/owner.json"
            ),
            expectedExecutable: layout.hostNode,
            expectedArguments: [layout.hostNode.path, layout.hostEntry.path],
            port: HostServiceExecution.declaredPort
        )
        let capture = captureQuiescenceEvidence(
            socketURL: applicationPaths.ipcDir.appendingPathComponent("audio_daemon.sock")
        )
        let ownersGone = host["state"] as? String == "absent"
            && capture["state"] as? String == "absent"
        let statusesStopped = statuses.values.allSatisfy { $0 == "notRegistered" }
        if (!ownersGone || !statusesStopped), attempt < 40 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.observeQuiescence(attempt: attempt + 1)
            }
            return
        }
        send([
            "statuses": statuses,
            "owners": ["host": host, "capture": capture],
        ])
    }

    private func observeRegistration(attempt: Int) {
        let statuses = services.statuses()
        let stable = statuses.values.allSatisfy {
            $0 == "enabled" || $0 == "requiresApproval"
        }
        if !stable, attempt < 40 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                self?.observeRegistration(attempt: attempt + 1)
            }
            return
        }
        send(["statuses": statuses])
    }

    private func healthPayload() -> [String: Any]? {
        guard let currentHealth,
              let appIdentity = codeIdentityEvidence(
                pid: Int(getpid()),
                staticURL: layout.bundleURL,
                expectedIdentifier: ProductSigningPolicy.applicationIdentifier,
                expectedTeamIdentifier: ProductSigningPolicy.teamIdentifier,
                allowAdHoc: ProductSigningPolicy.allowDevelopmentAdHoc
              ),
              let appGeneration = processStartGeneration(pid: Int(getpid())) else { return nil }
        let health = currentHealth()
        return applicationUpdateHealthPayload(
            currentVersion: currentVersion,
            currentBuild: currentBuild,
            applicationPID: Int(getpid()),
            applicationUID: Int(geteuid()),
            applicationGeneration: appGeneration,
            applicationExecutable: layout.bundleURL
                .appendingPathComponent("Contents/MacOS/yulu_app")
                .standardizedFileURL.resolvingSymlinksInPath().path,
            applicationIdentity: appIdentity,
            host: health.host,
            capture: health.capture,
            serviceStatuses: services.statuses()
        )
    }

    private func launchRollbackHelper(_ action: ApplicationUpdateAction) {
        guard let executable = action.executable,
              let script = action.script,
              let transactionId = action.transactionId,
              let generation = processStartGeneration(pid: Int(getpid()))?.split(separator: ":"),
              generation.count == 2 else {
            onStateChange?("blocked", "Rollback helper attestation is incomplete.")
            return
        }
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: executable)
        helper.arguments = [
            "-B",
            script,
            "recover",
            "--durable", applicationPaths.durableDataDir.path,
            "--cache", applicationPaths.cacheDir.path,
            "--application", layout.bundleURL.path,
            "--transaction-id", transactionId,
            "--parent-pid", String(getpid()),
            "--parent-start-seconds", String(generation[0]),
            "--parent-start-microseconds", String(generation[1]),
        ]
        var environment = sanitizedRuntimeEnvironment()
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        helper.environment = environment
        helper.standardInput = FileHandle.nullDevice
        helper.standardOutput = FileHandle.nullDevice
        helper.standardError = FileHandle.nullDevice
        do {
            try helper.run()
            rollbackHelperLaunched = true
            onRollbackHelperLaunched?()
        } catch {
            onStateChange?("blocked", "Verified rollback helper could not launch.")
        }
    }
}

func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value))
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func writeJSONObject(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    )
    FileHandle.standardOutput.write(Data("\n".utf8))
}

#if YULU_DEVELOPMENT_SMOKE
if CommandLine.arguments.count == 4,
   CommandLine.arguments[1] == "--inspect-migration-stderr-drain" {
    let errors = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[2])
    process.arguments = [CommandLine.arguments[3]]
    process.standardInput = FileHandle.nullDevice
    process.standardOutput = FileHandle.nullDevice
    process.standardError = errors
    let drain = BoundedRedactedStderrDrain()
    drain.start(errors.fileHandleForReading)
    do {
        try process.run()
        errors.fileHandleForWriting.closeFile()
        process.waitUntilExit()
        drain.finishAfterProcessExit()
        try writeJSON([
            "exited": process.terminationReason == .exit,
            "hadStderr": drain.hadOutput,
            "redacted": drain.hadOutput,
            "truncated": drain.truncated,
        ])
        exit(0)
    } catch {
        errors.fileHandleForWriting.closeFile()
        drain.finishAfterProcessExit()
        try writeJSON([
            "exited": false,
            "hadStderr": drain.hadOutput,
            "redacted": drain.hadOutput,
            "truncated": drain.truncated,
        ])
        exit(1)
    }
}

if CommandLine.arguments.count == 7,
   CommandLine.arguments[1] == "--inspect-code-identity" {
    let pid = CommandLine.arguments[2] == "self"
        ? Int(getpid())
        : Int(CommandLine.arguments[2])
    let allowAdHoc = CommandLine.arguments[6] == "1"
    if let pid,
       let evidence = codeIdentityEvidence(
        pid: pid,
        staticURL: URL(fileURLWithPath: CommandLine.arguments[3]),
        expectedIdentifier: CommandLine.arguments[4],
        expectedTeamIdentifier: CommandLine.arguments[5],
        allowAdHoc: allowAdHoc
       ) {
        try writeJSON(evidence)
    } else {
        try writeJSON(["accepted": false])
    }
    exit(0)
}
#endif

if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--apply-migration-service-action" {
    let policy = LaunchPolicy.evaluate(bundlePath: Bundle.main.bundleURL.path)
    guard policy.persistentRegistrationAllowed,
          let data = CommandLine.arguments[2].data(using: .utf8),
          let action = try? JSONDecoder().decode(MigrationServiceAction.self, from: data),
          action.action == "unregister_services" else {
        fputs("migration rollback adapter rejected the action\n", stderr)
        exit(78)
    }
    let registry = BackgroundServiceRegistry()
    guard action.apply(policy: policy, registrar: registry) else {
        fputs("migration rollback adapter could not apply the action\n", stderr)
        exit(78)
    }
    var statuses = registry.statuses()
    for _ in 0..<40 {
        if statuses.values.allSatisfy({ $0 == "notRegistered" || $0 == "notFound" }) {
            break
        }
        Thread.sleep(forTimeInterval: 0.25)
        statuses = registry.statuses()
    }
    try writeJSON(["statuses": statuses])
    guard statuses.values.allSatisfy({ $0 == "notRegistered" || $0 == "notFound" }) else {
        exit(75)
    }
    exit(0)
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

if CommandLine.arguments.count == 4,
   CommandLine.arguments[1] == "--inspect-migration-service-action" {
    let policy = LaunchPolicy.evaluate(bundlePath: CommandLine.arguments[2])
    guard let data = CommandLine.arguments[3].data(using: .utf8),
          let action = try? JSONDecoder().decode(MigrationServiceAction.self, from: data) else {
        fputs("invalid migration service action\n", stderr)
        exit(64)
    }
    let recorder = ServiceActionRecorder()
    _ = action.apply(policy: policy, registrar: recorder)
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

if CommandLine.arguments.count == 5,
   CommandLine.arguments[1] == "--inspect-fresh-install-registration",
   let attempt = Int(CommandLine.arguments[4]),
   let disposition = FreshInstallRegistrationDisposition.evaluate(
        statuses: [CommandLine.arguments[2], CommandLine.arguments[3]],
        attempt: attempt
   ) {
    try writeJSON(disposition)
    exit(0)
}

if CommandLine.arguments.count == 5,
   CommandLine.arguments[1] == "--inspect-fresh-install-health",
   let hostReady = Bool(CommandLine.arguments[2]),
   let captureReady = Bool(CommandLine.arguments[3]),
   let timedOut = Bool(CommandLine.arguments[4]) {
    try writeJSON(FreshInstallHealthDisposition.evaluate(
        hostReady: hostReady,
        captureReady: captureReady,
        timedOut: timedOut
    ))
    exit(0)
}

if CommandLine.arguments.count == 6,
   CommandLine.arguments[1] == "--inspect-fresh-install-recovery",
   let phaseActive = Bool(CommandLine.arguments[2]),
   let needsServiceReset = Bool(CommandLine.arguments[3]),
   let recoveryInProgress = Bool(CommandLine.arguments[4]),
   let action = FreshInstallRecoveryAction(rawValue: CommandLine.arguments[5]) {
    let plan = FreshInstallRecoveryPlan.evaluate(
        phaseActive: phaseActive,
        needsServiceReset: needsServiceReset,
        recoveryInProgress: recoveryInProgress,
        action: action
    )
    try writeJSON(plan)
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

if CommandLine.arguments.count == 6,
   CommandLine.arguments[1] == "--inspect-host-quiescence",
   let port = Int(CommandLine.arguments[5]) {
    let evidence = hostQuiescenceEvidence(
        ownerURL: URL(fileURLWithPath: CommandLine.arguments[2]),
        expectedExecutable: URL(fileURLWithPath: CommandLine.arguments[3]),
        expectedArguments: [CommandLine.arguments[3], CommandLine.arguments[4]],
        port: port
    )
    try FileHandle.standardOutput.write(
        contentsOf: JSONSerialization.data(
            withJSONObject: evidence,
            options: [.sortedKeys]
        ) + Data("\n".utf8)
    )
    exit(0)
}

if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--inspect-capture-quiescence" {
    let evidence = captureQuiescenceEvidence(
        socketURL: URL(fileURLWithPath: CommandLine.arguments[2])
    )
    try FileHandle.standardOutput.write(
        contentsOf: JSONSerialization.data(
            withJSONObject: evidence,
            options: [.sortedKeys]
        ) + Data("\n".utf8)
    )
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

if CommandLine.arguments.count == 4,
   CommandLine.arguments[1] == "--inspect-migration-command" {
    let bundleURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let homeURL = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
    let policy = LaunchPolicy.evaluate(bundlePath: bundleURL.path)
    try writeJSON(ApplicationMigrationCommand.make(
        policy: policy,
        layout: BundleLayout(bundleURL: bundleURL),
        applicationPaths: ApplicationDataPaths.resolve(
            homeDirectory: homeURL,
            environment: [:]
        ),
        homeDirectory: homeURL
    ))
    exit(0)
}

if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--inspect-update-configuration" {
    guard let info = NSDictionary(contentsOfFile: CommandLine.arguments[2]) as? [String: Any] else {
        fputs("invalid update configuration plist\n", stderr)
        exit(64)
    }
    try writeJSON(ApplicationUpdateConfiguration.evaluate(info: info))
    exit(0)
}

if CommandLine.arguments.count == 5,
   CommandLine.arguments[1] == "--inspect-update-termination" {
    let values = CommandLine.arguments[2...].map { $0 == "1" }
    try writeJSON(UpdateTerminationGate.evaluate(
        updatePending: values[values.startIndex],
        installAuthorized: values[values.index(after: values.startIndex)],
        rollbackHelperLaunched: values[values.index(values.startIndex, offsetBy: 2)]
    ))
    exit(0)
}

if CommandLine.arguments.count == 6,
   CommandLine.arguments[1] == "--inspect-update-command" {
    let bundleURL = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    let homeURL = URL(fileURLWithPath: CommandLine.arguments[3], isDirectory: true)
    try writeJSON(ApplicationUpdateCommand.make(
        policy: LaunchPolicy.evaluate(bundlePath: bundleURL.path),
        layout: BundleLayout(bundleURL: bundleURL),
        applicationPaths: ApplicationDataPaths.resolve(homeDirectory: homeURL, environment: [:]),
        currentVersion: "0.23.0",
        currentBuild: "730",
        targetVersion: CommandLine.arguments[4],
        targetBuild: CommandLine.arguments[5]
    ))
    exit(0)
}

if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--inspect-update-health-payload" {
    let layout = BundleLayout(
        bundleURL: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    )
    func inspectedIdentity(identifier: String, hash: String) -> CodeIdentityEvidence {
        CodeIdentityEvidence(
            accepted: true,
            identifier: identifier,
            teamIdentifier: ProductSigningPolicy.teamIdentifier,
            cdHash: hash,
            staticSealValid: true,
            dynamicValid: true,
            staticDynamicMatch: true
        )
    }
    let uid = Int(geteuid())
    let host = RuntimeOwnerEvidence(
        running: true,
        capabilityReady: nil,
        ownerPID: 102,
        codeIdentity: inspectedIdentity(identifier: "node", hash: String(repeating: "b", count: 40)),
        productVersion: "0.23.0",
        bundleVersion: "732",
        ipcVersion: ApplicationRuntimeContract.hostIPCVersion,
        database: RuntimeDatabaseEvidence(
            status: "ok",
            quickCheck: "ok",
            schemaVersion: ApplicationRuntimeContract.hostDatabaseSchemaVersion,
            minimumReadableVersion: ApplicationRuntimeContract.hostDatabaseMinimumReadableVersion
        ),
        ownerUID: uid,
        generation: "100:2",
        executablePath: layout.hostNode.path,
        authorityToken: "host-lock-token-1234",
        instanceNonce: "11111111-1111-4111-8111-111111111111"
    )
    let capture = RuntimeOwnerEvidence(
        running: true,
        capabilityReady: true,
        ownerPID: 103,
        codeIdentity: inspectedIdentity(
            identifier: ProductSigningPolicy.captureIdentifier,
            hash: String(repeating: "c", count: 40)
        ),
        productVersion: "0.23.0",
        bundleVersion: "732",
        ipcVersion: ApplicationRuntimeContract.captureIPCVersion,
        ownerUID: uid,
        generation: "100:3",
        executablePath: layout.captureExecutable.path
    )
    guard let payload = applicationUpdateHealthPayload(
        currentVersion: "0.23.0",
        currentBuild: "732",
        applicationPID: 101,
        applicationUID: uid,
        applicationGeneration: "100:1",
        applicationExecutable: layout.applicationExecutable.path,
        applicationIdentity: inspectedIdentity(
            identifier: ProductSigningPolicy.applicationIdentifier,
            hash: String(repeating: "a", count: 40)
        ),
        host: host,
        capture: capture,
        serviceStatuses: [
            "com.yulu.ui.plist": "enabled",
            "com.yulu.audiodaemon.plist": "enabled",
        ]
    ) else {
        exit(1)
    }
    try writeJSONObject(payload)
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

func processUID(pid: Int) -> Int? {
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
    return Int(info.pbi_uid)
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
    let codeIdentity = codeIdentityEvidence(
        pid: owner.pid,
        staticURL: expectedExecutable,
        expectedIdentifier: ProductSigningPolicy.hostIdentifier,
        expectedTeamIdentifier: ProductSigningPolicy.teamIdentifier,
        allowAdHoc: ProductSigningPolicy.allowDevelopmentAdHoc
    )
    let generationAfter = processStartGeneration(pid: owner.pid)
    return RuntimeOwnerAttestation(
        ownerPID: owner.pid,
        authorityToken: owner.token,
        generation: generationAfter,
        executableMatches: executableMatches,
        argumentsMatch: argumentsMatch,
        generationStable: generationBefore != nil && generationBefore == generationAfter,
        codeIdentity: codeIdentity,
        ownerUID: processUID(pid: owner.pid),
        executablePath: expectedExecutable.standardizedFileURL
            .resolvingSymlinksInPath().path
    )
}

struct CaptureRuntimeStatus {
    let evidence: RuntimeOwnerEvidence
    let recording: Bool?

    static var unavailable: CaptureRuntimeStatus {
        CaptureRuntimeStatus(
            evidence: RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil),
            recording: nil
        )
    }
}

func captureRuntimeStatus(socketURL: URL, expectedExecutable: URL) -> CaptureRuntimeStatus {
    let socketPath = socketURL.path
    guard socketPath.utf8.count <= 103 else {
        return .unavailable
    }
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
        return .unavailable
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
        return .unavailable
    }
    var peerPID: Int32 = 0
    var peerPIDSize = socklen_t(MemoryLayout<Int32>.size)
    var peerUID = uid_t(0)
    var peerGID = gid_t(0)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &peerPIDSize) == 0,
          getpeereid(fd, &peerUID, &peerGID) == 0,
          peerPID > 1,
          peerUID == geteuid() else {
        return .unavailable
    }
    let generationBefore = processStartGeneration(pid: Int(peerPID))
    let request = Data("{\"action\":\"status\"}".utf8)
    guard request.withUnsafeBytes({ Darwin.write(fd, $0.baseAddress, request.count) }) == request.count else {
        return .unavailable
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
        return .unavailable
    }
    let generationAfterResponse = processStartGeneration(pid: Int(peerPID))
    let executableMatches = processExecutableMatches(
        pid: Int(peerPID),
        expectedURL: expectedExecutable
    )
    let codeIdentity = codeIdentityEvidence(
        pid: Int(peerPID),
        staticURL: expectedExecutable,
        expectedIdentifier: ProductSigningPolicy.captureIdentifier,
        expectedTeamIdentifier: ProductSigningPolicy.teamIdentifier,
        allowAdHoc: ProductSigningPolicy.allowDevelopmentAdHoc
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
            && generationAfterResponse == generationAfterIdentity,
        codeIdentity: codeIdentity,
        ownerUID: Int(peerUID),
        executablePath: expectedExecutable.standardizedFileURL
            .resolvingSymlinksInPath().path
    )
    guard let evidence = RuntimeOwnerEvidence.evaluate(
        kind: "capture",
        payload: payload,
        attestation: attestation
    ) else { return .unavailable }
    return CaptureRuntimeStatus(
        evidence: evidence,
        recording: payload["recording"] as? Bool
    )
}

func captureRuntimeEvidence(socketURL: URL, expectedExecutable: URL) -> RuntimeOwnerEvidence {
    captureRuntimeStatus(socketURL: socketURL, expectedExecutable: expectedExecutable).evidence
}

private func hostPortQuiescenceEvidence(port: Int) -> [String: Any] {
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else {
        return ["state": "unknown", "proof": "tcp-socket-unavailable"]
    }
    defer { Darwin.close(fd) }
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(
        fd,
        SOL_SOCKET,
        SO_SNDTIMEO,
        &timeout,
        socklen_t(MemoryLayout<timeval>.size)
    )
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port).bigEndian)
    address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    if connected == 0 {
        return ["state": "unknown", "proof": "tcp-listener-present"]
    }
    if errno == ECONNREFUSED {
        return ["state": "absent", "proof": "tcp-refused"]
    }
    return ["state": "unknown", "proof": "tcp-observation-failed"]
}

private func ownerRecordPresence(_ ownerURL: URL) -> String {
    var metadata = stat()
    if Darwin.lstat(ownerURL.path, &metadata) == 0 {
        return "present"
    }
    return errno == ENOENT ? "absent" : "unknown"
}

func hostQuiescenceEvidence(
    ownerURL: URL,
    expectedExecutable: URL,
    expectedArguments: [String],
    port: Int
) -> [String: Any] {
    let portEvidence = hostPortQuiescenceEvidence(port: port)
    let recordPresence = ownerRecordPresence(ownerURL)
    let attestation = hostRuntimeAttestation(
        ownerURL: ownerURL,
        expectedExecutable: expectedExecutable,
        expectedArguments: expectedArguments
    )
    if portEvidence["state"] as? String == "absent",
       recordPresence == "absent" {
        return [
            "state": "absent",
            "proof": "tcp-refused-owner-record-absent",
        ]
    }
    if let attestation,
       attestation.generationStable,
       attestation.executableMatches,
       attestation.argumentsMatch {
        return [
            "state": "present-attested",
            "pid": attestation.ownerPID,
            "generation": attestation.generation ?? "",
        ]
    }
    return [
        "state": "unknown",
        "proof": recordPresence == "present"
            ? "owner-record-unattested"
            : (portEvidence["proof"] as? String ?? "host-observation-failed"),
    ]
}

func captureQuiescenceEvidence(socketURL: URL) -> [String: Any] {
    let socketPath = socketURL.path
    guard socketPath.utf8.count <= 103 else {
        return ["state": "unknown", "proof": "unix-path-invalid"]
    }
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else {
        return ["state": "unknown", "proof": "unix-socket-unavailable"]
    }
    defer { Darwin.close(fd) }
    var timeout = timeval(tv_sec: 1, tv_usec: 0)
    setsockopt(
        fd,
        SOL_SOCKET,
        SO_SNDTIMEO,
        &timeout,
        socklen_t(MemoryLayout<timeval>.size)
    )
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
    if connected != 0 {
        if errno == ENOENT || errno == ECONNREFUSED {
            return ["state": "absent", "proof": "unix-missing-or-refused"]
        }
        return ["state": "unknown", "proof": "unix-observation-failed"]
    }
    var peerPID: Int32 = 0
    var peerPIDSize = socklen_t(MemoryLayout<Int32>.size)
    var peerUID = uid_t(0)
    var peerGID = gid_t(0)
    guard getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &peerPID, &peerPIDSize) == 0,
          getpeereid(fd, &peerUID, &peerGID) == 0,
          peerPID > 1,
          peerUID == geteuid(),
          let generation = processStartGeneration(pid: Int(peerPID)) else {
        return ["state": "unknown", "proof": "unix-peer-unattested"]
    }
    return [
        "state": "present-attested",
        "pid": Int(peerPID),
        "uid": Int(peerUID),
        "generation": generation,
    ]
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

#if canImport(Sparkle)
final class SparkleUpdateAdapter: NSObject, SPUUpdaterDelegate {
    private let coordinator: ApplicationUpdateCoordinator
    private let currentBuild: String
    private lazy var controller = SPUStandardUpdaterController(
        updaterDelegate: self,
        userDriverDelegate: nil
    )

    init(coordinator: ApplicationUpdateCoordinator, currentBuild: String) {
        self.coordinator = coordinator
        self.currentBuild = currentBuild
        super.init()
        _ = controller
    }

    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }

    func updater(
        _ updater: SPUUpdater,
        shouldProceedWithUpdate item: SUAppcastItem,
        updateCheck: SPUUpdateCheck
    ) throws {
        guard item.installationType == "application",
              item.fileURL?.scheme?.lowercased() == "https",
              item.fileURL?.pathExtension.lowercased() == "dmg",
              item.deltaUpdates?[currentBuild] == nil,
              let current = Int(currentBuild),
              let target = Int(item.versionString),
              target > current else {
            throw NSError(
                domain: "YuluApplicationUpdate",
                code: 1,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "Yulu requires a monotonic, whole-application, signed DMG update without a delta."
                ]
            )
        }
    }

    func updater(
        _ updater: SPUUpdater,
        shouldPostponeRelaunchForUpdate item: SUAppcastItem,
        untilInvokingBlock installHandler: @escaping () -> Void
    ) -> Bool {
        coordinator.prepareInstall(
            targetVersion: item.displayVersionString,
            targetBuild: item.versionString,
            installHandler: installHandler
        )
        return true
    }

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
    private var migrationCoordinator: ApplicationMigrationCoordinator?
    private weak var cancelMigrationMenuItem: NSMenuItem?
    private weak var retryMigrationMenuItem: NSMenuItem?
    private var updateCoordinator: ApplicationUpdateCoordinator?
    #if canImport(Sparkle)
    private var sparkleAdapter: SparkleUpdateAdapter?
    #endif
    private var migrationCommitted = false
    private var migrationStarted = false
    private var migrationRetryAvailable = false
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
        self.window = window
        if let guidance = launchPolicy.guidance {
            window.contentView = centeredMessage(guidance, detail: "Yulu runs services and updates only from /Applications/Yulu.app.")
        } else if let applicationPaths {
            window.contentView = centeredMessage("Starting Yulu…", detail: "Waiting for the bundled Host.")
            let coordinator = ApplicationUpdateCoordinator(
                policy: launchPolicy,
                layout: layout,
                applicationPaths: applicationPaths,
                services: backgroundServices
            )
            coordinator.onStateChange = { [weak self] state, detail in
                self?.updateStateChanged(state, detail: detail)
            }
            coordinator.onCanStartMigration = { [weak self] in self?.startMigration() }
            coordinator.onNeedsHealth = { [weak self] in
                self?.beginServicePolling()
            }
            coordinator.currentHealth = { [weak self] in
                guard let self else {
                    return (
                        RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil),
                        RuntimeOwnerEvidence(running: false, capabilityReady: nil, ownerPID: nil)
                    )
                }
                return (self.hostEvidence, self.captureEvidence)
            }
            coordinator.onRollbackHelperLaunched = { NSApp.terminate(nil) }
            updateCoordinator = coordinator
            coordinator.resume()
        }
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let updateCoordinator else { return .terminateNow }
        let allowTermination = UpdateTerminationGate.allowTermination(
            updatePending: updateCoordinator.updatePending,
            installAuthorized: updateCoordinator.installAuthorized,
            rollbackHelperLaunched: updateCoordinator.rollbackHelperLaunched
        )
        return allowTermination ? .terminateNow : .terminateCancel
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        guard launchPolicy.installed else { return }
        refreshServiceWindow()
        migrationCoordinator?.advance(event: "resume")
        if migrationCommitted { beginServicePolling() }
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
        let checkForUpdates = appMenu.addItem(
            withTitle: "Check for Updates…",
            action: #selector(onCheckForUpdates),
            keyEquivalent: ""
        )
        checkForUpdates.target = self
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
        components.autoenablesItems = false
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
        let cancelMigration = components.addItem(
            withTitle: "Cancel Service Migration…",
            action: #selector(onCancelMigration),
            keyEquivalent: ""
        )
        cancelMigration.target = self
        cancelMigrationMenuItem = cancelMigration
        let retryMigration = components.addItem(
            withTitle: "Retry Service Migration…",
            action: #selector(onRetryMigration),
            keyEquivalent: ""
        )
        retryMigration.target = self
        retryMigration.isEnabled = false
        retryMigrationMenuItem = retryMigration
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

    @objc private func onCancelMigration() {
        guard launchPolicy.installed, !migrationCommitted else { return }
        migrationCoordinator?.cancel()
    }

    @objc private func onRetryMigration() {
        guard launchPolicy.installed,
              !migrationCommitted,
              migrationRetryAvailable else { return }
        migrationRetryAvailable = false
        retryMigrationMenuItem?.isEnabled = false
        migrationCoordinator?.retry()
    }

    @objc private func onCheckForUpdates() {
        #if canImport(Sparkle)
        sparkleAdapter?.checkForUpdates()
        #endif
    }

    @objc private func onReturnToPreviousApplication() {
        updateCoordinator?.requestRollback()
    }

    private func startMigration() {
        guard !migrationStarted, let applicationPaths else { return }
        migrationStarted = true
        let coordinator = ApplicationMigrationCoordinator(
            policy: launchPolicy,
            layout: layout,
            applicationPaths: applicationPaths,
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser,
            services: backgroundServices
        )
        coordinator.onStateChange = { [weak self] state, detail in
            self?.migrationStateChanged(state, detail: detail)
        }
        coordinator.onNeedsHealth = { [weak self] in self?.beginServicePolling() }
        migrationCoordinator = coordinator
        coordinator.advance()
    }

    private func updateStateChanged(_ state: String, detail: String?) {
        switch state {
        case "deferred":
            window?.contentView = centeredMessage(
                "Update deferred",
                detail: detail == "recording-active"
                    ? "Yulu will continue after the active recording finishes."
                    : "Yulu could not safely verify recording state and will retry."
            )
        case "installing":
            window?.contentView = centeredMessage(
                "Installing Yulu update…",
                detail: "The previous whole application and a data checkpoint are verified."
            )
        case "verifying":
            window?.contentView = centeredMessage(
                "Validating the Yulu update…",
                detail: "Checking application, Host, Capture, database, service, and IPC compatibility."
            )
        case "awaiting_approval":
            window?.contentView = centeredMessage(
                "Background approval is required",
                detail: "Open Login Items settings to allow Yulu in the background, then return here."
            )
            refreshServiceWindow(show: true)
        case "rollback_offered":
            let message = centeredMessage(
                "The Yulu update did not pass its health check",
                detail: "Your live data remains in place. You can return to the verified previous application."
            )
            let button = NSButton(
                title: "Return to Previous Yulu…",
                target: self,
                action: #selector(onReturnToPreviousApplication)
            )
            button.translatesAutoresizingMaskIntoConstraints = false
            message.addSubview(button)
            NSLayoutConstraint.activate([
                button.centerXAnchor.constraint(equalTo: message.centerXAnchor),
                button.bottomAnchor.constraint(equalTo: message.bottomAnchor, constant: -80),
            ])
            window?.contentView = message
        case "blocked":
            window?.contentView = centeredMessage(
                "Yulu update needs attention",
                detail: detail ?? "The update stopped without changing data further."
            )
        default:
            break
        }
    }

    private func migrationStateChanged(_ state: String, detail: String?) {
        switch state {
        case "registering":
            migrationRetryAvailable = false
            cancelMigrationMenuItem?.isEnabled = true
            retryMigrationMenuItem?.isEnabled = false
            window?.contentView = centeredMessage(
                "Setting up background services…",
                detail: "Registering the bundled Host and Capture owners."
            )
        case "awaiting_approval":
            migrationRetryAvailable = false
            cancelMigrationMenuItem?.isEnabled = true
            retryMigrationMenuItem?.isEnabled = false
            window?.contentView = centeredMessage(
                "Background approval is required",
                detail: "Open Login Items settings to allow Yulu in the background, then return here. You can cancel from Components."
            )
            refreshServiceWindow(show: true)
        case "verifying":
            migrationRetryAvailable = false
            cancelMigrationMenuItem?.isEnabled = true
            retryMigrationMenuItem?.isEnabled = false
            window?.contentView = centeredMessage(
                "Finishing migration…",
                detail: "Verifying the bundled Host and Capture owners."
            )
        case "cancelling":
            migrationRetryAvailable = false
            cancelMigrationMenuItem?.isEnabled = false
            retryMigrationMenuItem?.isEnabled = false
            window?.contentView = centeredMessage(
                "Stopping background services…",
                detail: detail == FreshInstallRecoveryAction.retry.rawValue
                    ? "Yulu will register a fresh service set after cleanup."
                    : "Yulu will leave both bundled services unregistered."
            )
        case "committed":
            migrationCommitted = true
            migrationRetryAvailable = false
            cancelMigrationMenuItem?.isEnabled = false
            retryMigrationMenuItem?.isEnabled = false
            window?.contentView = centeredMessage("Starting Yulu…", detail: "Waiting for the bundled Host.")
            configureUpdater()
            beginServicePolling()
        case "rolled_back":
            migrationRetryAvailable = true
            cancelMigrationMenuItem?.isEnabled = false
            retryMigrationMenuItem?.isEnabled = true
            showMigrationRetry(
                "Migration was cancelled",
                detail: "The previous Yulu background services were restored."
            )
        case "fresh_install_cancelled":
            migrationRetryAvailable = true
            cancelMigrationMenuItem?.isEnabled = false
            retryMigrationMenuItem?.isEnabled = true
            showMigrationRetry(
                "Background setup was cancelled",
                detail: "No Yulu background service remains registered. Retry when you are ready."
            )
        case "registration_blocked":
            migrationRetryAvailable = true
            cancelMigrationMenuItem?.isEnabled = true
            retryMigrationMenuItem?.isEnabled = true
            showMigrationRetry(
                "Background service registration failed",
                detail: "\(detail ?? "Yulu could not register its bundled background services.") Retry the service setup, or open Background Services for current status."
            )
        case "health_blocked":
            migrationRetryAvailable = true
            cancelMigrationMenuItem?.isEnabled = true
            retryMigrationMenuItem?.isEnabled = true
            showMigrationRetry(
                "Yulu components did not become ready",
                detail: "\(detail ?? "The bundled services did not become ready.") Retry restarts both bundled services; Background Services shows their current status."
            )
        case "blocked":
            migrationRetryAvailable = false
            cancelMigrationMenuItem?.isEnabled = false
            retryMigrationMenuItem?.isEnabled = false
            window?.contentView = centeredMessage(
                "Yulu migration needs attention",
                detail: detail ?? "No persistent service state was changed further."
            )
        default:
            break
        }
    }

    private func showMigrationRetry(_ title: String, detail: String) {
        let message = centeredMessage(title, detail: detail)
        let button = NSButton(
            title: "Retry Service Migration…",
            target: self,
            action: #selector(onRetryMigration)
        )
        button.translatesAutoresizingMaskIntoConstraints = false
        message.addSubview(button)
        NSLayoutConstraint.activate([
            button.centerXAnchor.constraint(equalTo: message.centerXAnchor),
            button.bottomAnchor.constraint(equalTo: message.bottomAnchor, constant: -80),
        ])
        window?.contentView = message
    }

    private func configureUpdater() {
        #if canImport(Sparkle)
        guard sparkleAdapter == nil,
              ApplicationUpdateConfiguration.evaluate(
                info: Bundle.main.infoDictionary ?? [:]
              ).enabled,
              let updateCoordinator,
              let currentBuild = Bundle.main.infoDictionary?["CFBundleVersion"] as? String else {
            return
        }
        sparkleAdapter = SparkleUpdateAdapter(
            coordinator: updateCoordinator,
            currentBuild: currentBuild
        )
        #endif
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
            let ownerURL = applicationPaths.durableDataDir
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
                self.migrationCoordinator?.submitHealth(
                    host: self.hostEvidence,
                    capture: self.captureEvidence
                )
                self.updateCoordinator?.submitHealth()
                self.refreshServiceWindow()
                if responseHealthy {
                    self.hostPollAttempts = 0
                    if self.migrationCommitted && self.webView == nil { self.open(route: "/") }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                        self.pollHost(generation: generation)
                    }
                } else if self.hostPollAttempts < 60 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        self.pollHost(generation: generation)
                    }
                } else if self.migrationCommitted {
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
                self.migrationCoordinator?.submitHealth(
                    host: self.hostEvidence,
                    capture: self.captureEvidence
                )
                self.updateCoordinator?.submitHealth()
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
