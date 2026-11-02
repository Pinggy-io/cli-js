// Prints the on-screen windows of SecurityAgent, the process that draws Keychain dialogs, as JSON.
// Owner names and bounds need no Screen Recording grant.

import CoreGraphics
import Foundation

let dialogOwner = "SecurityAgent"
let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
let dialogs = windows.filter { ($0[kCGWindowOwnerName as String] as? String) == dialogOwner }.map { window in
    [
        "window_id": window[kCGWindowNumber as String] ?? 0,
        "owner_pid": window[kCGWindowOwnerPID as String] ?? 0,
        "bounds": window[kCGWindowBounds as String] ?? [:],
    ]
}
let json = try JSONSerialization.data(withJSONObject: dialogs)
print(String(data: json, encoding: .utf8) ?? "[]")
