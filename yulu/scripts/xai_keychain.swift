import Foundation
import Security

private let service = "com.yulu.xai-oauth"
private let account = "default"
private let notFoundExit: Int32 = 44

private func baseQuery() -> [CFString: Any] {
    return [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: service,
        kSecAttrAccount: account,
    ]
}

private func fail(_ message: String, status: OSStatus? = nil) -> Never {
    let suffix = status.map { " (OSStatus \($0))" } ?? ""
    FileHandle.standardError.write(Data("\(message)\(suffix)\n".utf8))
    exit(1)
}

private func readSecret() {
    var query = baseQuery()
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

private func writeSecret() {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, data.count <= 65_536 else {
        fail("Invalid xAI OAuth payload")
    }
    guard (try? JSONSerialization.jsonObject(with: data)) is [String: Any] else {
        fail("xAI OAuth payload must be a JSON object")
    }

    let query = baseQuery()
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

private func deleteSecret() {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    if status == errSecItemNotFound { exit(notFoundExit) }
    guard status == errSecSuccess else {
        fail("Unable to delete xAI OAuth from Keychain", status: status)
    }
}

guard CommandLine.arguments.count == 2 else {
    fail("Usage: xai_keychain <read|write|delete>")
}

switch CommandLine.arguments[1] {
case "read": readSecret()
case "write": writeSecret()
case "delete": deleteSecret()
default: fail("Unknown command")
}
