import EventKit
import Foundation

private enum AccessDecision {
    case granted
    case denied
    case restricted
    case notDetermined
}

private func emit(_ payload: [String: Any], exitCode: Int32) -> Never {
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(exitCode)
}

private func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name),
          CommandLine.arguments.indices.contains(index + 1) else { return nil }
    return CommandLine.arguments[index + 1]
}

private func parseDate(_ value: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
}

private func requestedCalendarNames() -> Set<String> {
    guard let raw = argument("--calendars-json"),
          let data = raw.data(using: .utf8),
          let values = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
    return Set(values.filter { !$0.isEmpty })
}

private func isoDate(_ value: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: value)
}

private func eventPayload(_ event: EKEvent) -> [String: Any] {
    let attendees = (event.attendees ?? []).compactMap { participant in
        let name = participant.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? nil : name
    }
    let identifier = event.eventIdentifier ?? [
        event.calendar.calendarIdentifier,
        event.title ?? "",
        isoDate(event.startDate),
    ].joined(separator: ":")
    return [
        "id": identifier,
        "title": event.title ?? "(无标题)",
        "start": isoDate(event.startDate),
        "end": isoDate(event.endDate),
        "link": event.url?.absoluteString ?? "",
        "attendees": attendees,
        "description": event.notes ?? "",
        "calendar": event.calendar.title,
    ]
}

private func accessDecision(_ status: EKAuthorizationStatus) -> AccessDecision {
    if #available(macOS 14.0, *) {
        switch status {
        case .fullAccess, .authorized:
            return .granted
        case .denied, .writeOnly:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .notDetermined
        }
    } else {
        switch status {
        case .authorized, .fullAccess:
            return .granted
        case .denied, .writeOnly:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            return .notDetermined
        @unknown default:
            return .notDetermined
        }
    }
}

private func requestEventAccess(_ store: EKEventStore) {
    let semaphore = DispatchSemaphore(value: 0)
    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { _, _ in semaphore.signal() }
    } else {
        store.requestAccess(to: .event) { _, _ in semaphore.signal() }
    }
    _ = semaphore.wait(timeout: .now() + 30)
}

if CommandLine.arguments.contains("--self-test") {
    guard CommandLine.arguments.count == 2 else {
        emit(["ok": false, "reason": "invalid_self_test"], exitCode: 2)
    }
    emit(["ok": true, "helper": "calendar_probe"], exitCode: 0)
}

guard let startRaw = argument("--start"),
      let endRaw = argument("--end"),
      let start = parseDate(startRaw),
      let end = parseDate(endRaw),
      end > start,
      end.timeIntervalSince(start) <= 48 * 60 * 60 else {
    emit([
        "ok": false,
        "reason": "enumeration_failed",
    ], exitCode: 2)
}

let store = EKEventStore()
if accessDecision(EKEventStore.authorizationStatus(for: .event)) == .notDetermined {
    requestEventAccess(store)
}

switch accessDecision(EKEventStore.authorizationStatus(for: .event)) {
case .denied:
    emit(["ok": false, "reason": "authorization_denied"], exitCode: 2)
case .restricted:
    emit(["ok": false, "reason": "authorization_restricted"], exitCode: 2)
case .notDetermined:
    emit(["ok": false, "reason": "authorization_not_determined"], exitCode: 2)
case .granted:
    let requestedNames = requestedCalendarNames()
    let selectedCalendars = requestedNames.isEmpty
        ? nil
        : store.calendars(for: .event).filter { requestedNames.contains($0.title) }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: selectedCalendars)
    let events = store.events(matching: predicate)
    if CommandLine.arguments.contains("--events") {
        emit([
            "ok": true,
            "events": events.map(eventPayload),
            "start": startRaw,
            "end": endRaw,
        ], exitCode: 0)
    }
    emit([
        "ok": true,
        "access": "granted",
        "enumerationSucceeded": true,
        "eventCount": events.count,
        "start": startRaw,
        "end": endRaw,
    ], exitCode: 0)
}
