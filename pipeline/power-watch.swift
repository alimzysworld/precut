import Foundation
import IOKit.ps

// Push once at launch and on system notifications; no timer or sampling loop.
func emitPower() {
    var current = 0, maximum = 0
    if let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
       let sources = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] {
        for source in sources {
            if let value = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
               value[kIOPSTypeKey] as? String == kIOPSInternalBatteryType {
                current += value[kIOPSCurrentCapacityKey] as? Int ?? 0
                maximum += value[kIOPSMaxCapacityKey] as? Int ?? 0
            }
        }
    }
    let data: [String: Any] = ["batteryPercent": maximum > 0 ? 100 * current / maximum : 100,
                               "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled]
    if let bytes = try? JSONSerialization.data(withJSONObject: data), let line = String(data: bytes, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}
let observer = NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: nil) { _ in emitPower() }
let source = IOPSNotificationCreateRunLoopSource({ _ in emitPower() }, nil).takeRetainedValue()
CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .defaultMode)
emitPower()
CFRunLoopRun()
