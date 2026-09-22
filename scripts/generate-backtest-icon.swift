import AppKit
import Foundation

let pixels = 1024
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else { fatalError("Cannot create icon bitmap") }

func color(_ hex: UInt32, _ alpha: CGFloat = 1) -> NSColor {
    NSColor(
        calibratedRed: CGFloat((hex >> 16) & 255) / 255,
        green: CGFloat((hex >> 8) & 255) / 255,
        blue: CGFloat(hex & 255) / 255,
        alpha: alpha
    )
}

func rounded(_ rect: NSRect, _ radius: CGFloat) -> NSBezierPath {
    NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}

func line(_ points: [NSPoint], stroke: NSColor, width: CGFloat) {
    guard let first = points.first else { return }
    let path = NSBezierPath()
    path.move(to: first)
    for point in points.dropFirst() { path.line(to: point) }
    path.lineWidth = width
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    stroke.setStroke()
    path.stroke()
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
NSGraphicsContext.current?.shouldAntialias = true

let tile = rounded(NSRect(x: 56, y: 56, width: 912, height: 912), 224)
NSGradient(starting: color(0x17132e), ending: color(0x292463))!.draw(in: tile, angle: -55)
tile.lineWidth = 8
color(0x7770d4, 0.48).setStroke()
tile.stroke()

for y in [294.0, 426.0, 558.0, 690.0] {
    line([NSPoint(x: 150, y: y), NSPoint(x: 874, y: y)],
         stroke: color(0x9a91d7, 0.12), width: 4)
}
for x in [227.0, 357.0, 487.0, 617.0, 747.0] {
    line([NSPoint(x: x, y: 245), NSPoint(x: x, y: 748)],
         stroke: color(0x9a91d7, 0.09), width: 4)
}

let candles: [(CGFloat, CGFloat, CGFloat, CGFloat, UInt32)] = [
    (255, 352, 418, 522, 0x8be5de),
    (372, 428, 520, 622, 0x958dff),
    (489, 479, 577, 691, 0x8be5de),
]
for (x, low, bodyBottom, high, tint) in candles {
    let glow = NSShadow()
    glow.shadowColor = color(tint, 0.50)
    glow.shadowBlurRadius = 22
    glow.set()
    line([NSPoint(x: x, y: low), NSPoint(x: x, y: high)],
         stroke: color(tint, 0.86), width: 14)
    let body = rounded(NSRect(x: x - 29, y: bodyBottom, width: 58, height: 94), 12)
    color(tint).setFill()
    body.fill()
    NSShadow().set()
}

let disc = NSBezierPath(ovalIn: NSRect(x: 589, y: 381, width: 263, height: 263))
let halo = NSShadow()
halo.shadowColor = color(0xa29cff, 0.82)
halo.shadowBlurRadius = 58
halo.set()
color(0x5e57d9).setFill()
disc.fill()
NSShadow().set()
disc.lineWidth = 9
color(0xb7b3ff, 0.86).setStroke()
disc.stroke()

let play = NSBezierPath()
play.move(to: NSPoint(x: 681, y: 451))
play.line(to: NSPoint(x: 681, y: 575))
play.line(to: NSPoint(x: 783, y: 513))
play.close()
color(0xf6f5ff).setFill()
play.fill()

let label = "BT" as NSString
let font = NSFont.systemFont(ofSize: 116, weight: .heavy)
let attributes: [NSAttributedString.Key: Any] = [
    .font: font, .foregroundColor: color(0xf4f2ff),
    .kern: 4,
]
let size = label.size(withAttributes: attributes)
label.draw(at: NSPoint(x: (1024 - size.width) / 2, y: 151), withAttributes: attributes)

NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode icon PNG")
}
let output = URL(fileURLWithPath: "assets/backtesting-icon.png")
try FileManager.default.createDirectory(at: output.deletingLastPathComponent(),
                                        withIntermediateDirectories: true)
try png.write(to: output)
print("Generated \(output.path)")
