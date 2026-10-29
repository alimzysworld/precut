// Apple's place names only. Coordinates come from file metadata, never a model.
import Foundation
import CoreLocation

guard CommandLine.arguments.count == 3,
      let lat = Double(CommandLine.arguments[1]), let lon = Double(CommandLine.arguments[2]),
      lat.isFinite, lon.isFinite, abs(lat) <= 90, abs(lon) <= 180 else { exit(2) }
let geocoder = CLGeocoder()
var finished = false
var name: String? = nil
geocoder.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lon)) { places, _ in
    if let p = places?.first {
        name = p.areasOfInterest?.first ?? p.name ?? p.locality
    }
    finished = true
}
let deadline = Date().addingTimeInterval(4)
while !finished && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
if !finished { geocoder.cancelGeocode() }
let data = try JSONSerialization.data(withJSONObject: ["name": name as Any? ?? NSNull()])
FileHandle.standardOutput.write(data)
