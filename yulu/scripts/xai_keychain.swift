import Foundation
import Security

private let oauthService = "com.yulu.xai-oauth"
private let providerSecretService = "com.yulu.provider-secret"
private let retiredGatewayAccountPrefix = "gateway.cliproxyapi."
private let notFoundExit: Int32 = 44

private struct Target {
    let service: String
    let account: String
}

private func target(for slot: String?) -> Target {
    guard let slot else {
        return Target(service: oauthService, account: "default")
    }
    guard slot == "direct.xai" else {
        fail("Invalid provider secret slot")
    }
    return Target(service: providerSecretService, account: slot)
}

private func baseQuery(_ target: Target) -> [CFString: Any] {
    return [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: target.service,
        kSecAttrAccount: target.account,
    ]
}

private func fail(_ message: String, status: OSStatus? = nil) -> Never {
    let suffix = status.map { " (OSStatus \($0))" } ?? ""
    FileHandle.standardError.write(Data("\(message)\(suffix)\n".utf8))
    exit(1)
}

private func readSecret(_ target: Target) {
    var query = baseQuery(target)
    query[kSecReturnData] = true
    query[kSecMatchLimit] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { exit(notFoundExit) }
    guard status == errSecSuccess, let data = result as? Data else {
        fail("Unable to read xAI OAuth from Keychain", status: status)
    }
    FileHandle.standardOutput.write(data)
}

private func writeSecret(_ target: Target) {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, data.count <= 65_536 else {
        fail("Invalid xAI OAuth payload")
    }
    guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
        fail("xAI OAuth payload must be a JSON object")
    }

    let query = baseQuery(target)
    let updateStatus = SecItemUpdate(
        query as CFDictionary,
        [kSecValueData: data] as CFDictionary
    )
    if updateStatus == errSecSuccess { return }
    guard updateStatus == errSecItemNotFound else {
        fail("Unable to update xAI OAuth in Keychain", status: updateStatus)
    }

    var attributes = query
    attributes[kSecValueData] = data
    attributes[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let addStatus = SecItemAdd(attributes as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
        fail("Unable to save xAI OAuth in Keychain", status: addStatus)
    }
}

private func deleteSecret(_ target: Target) {
    let status = SecItemDelete(baseQuery(target) as CFDictionary)
    if status == errSecItemNotFound { exit(notFoundExit) }
    guard status == errSecSuccess else {
        fail("Unable to delete xAI OAuth from Keychain", status: status)
    }
}

private func deleteRetiredGatewaySecrets() {
    let query: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: providerSecretService,
        kSecReturnAttributes: true,
        kSecMatchLimit: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else {
        fail("Unable to enumerate retired Yulu provider secrets", status: status)
    }
    for item in items {
        guard
            let account = item[kSecAttrAccount as String] as? String,
            account.hasPrefix(retiredGatewayAccountPrefix),
            UUID(uuidString: String(account.dropFirst(retiredGatewayAccountPrefix.count))) != nil
        else { continue }
        let deleteStatus = SecItemDelete(baseQuery(Target(service: providerSecretService, account: account)) as CFDictionary)
        guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
            fail("Unable to delete retired Yulu provider secret", status: deleteStatus)
        }
    }
}

guard CommandLine.arguments.count == 2 || CommandLine.arguments.count == 3 else {
    fail("Usage: xai_keychain <read|write|delete> [direct.xai] | delete-retired-gateway-secrets")
}

switch CommandLine.arguments[1] {
case "read": readSecret(target(for: CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : nil))
case "write": writeSecret(target(for: CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : nil))
case "delete": deleteSecret(target(for: CommandLine.arguments.count == 3 ? CommandLine.arguments[2] : nil))
case "delete-retired-gateway-secrets":
    guard CommandLine.arguments.count == 2 else { fail("Retired provider cleanup does not accept a slot") }
    deleteRetiredGatewaySecrets()
default: fail("Unknown command")
}
