// Renders the openCycle app icon: the favicon's ring-and-orbit mark in mint
// on the dark rounded square macOS expects. Drawing it here (rather than
// rasterizing the SVG) keeps the build to tools every Mac already has.
//
// Usage: make-icon <out.png> [pixels]

import AppKit
import Foundation

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write(Data("usage: make-icon <out.png> [pixels]\n".utf8))
    exit(2)
}
let outPath = arguments[1]
let pixels = arguments.count > 2 ? (Int(arguments[2]) ?? 1024) : 1024
let size = CGFloat(pixels)

guard let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else {
    FileHandle.standardError.write(Data("make-icon: could not allocate a bitmap\n".utf8))
    exit(1)
}
guard let context = NSGraphicsContext(bitmapImageRep: rep) else {
    FileHandle.standardError.write(Data("make-icon: could not create a drawing context\n".utf8))
    exit(1)
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
let cg = context.cgContext
cg.setAllowsAntialiasing(true)

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 0xff) / 255,
        green: CGFloat((hex >> 8) & 0xff) / 255,
        blue: CGFloat(hex & 0xff) / 255,
        alpha: alpha
    )
}

let mint = color(0x5ee6a8)

// Background: the macOS icon grid (an 824pt rounded square inside 1024pt),
// filled with a vertical gradient from the app's deep surface to its void.
let margin = size * 0.0977
let tile = CGRect(x: margin, y: margin, width: size - margin * 2, height: size - margin * 2)
let tilePath = CGPath(
    roundedRect: tile, cornerWidth: size * 0.1807, cornerHeight: size * 0.1807, transform: nil
)
cg.saveGState()
cg.addPath(tilePath)
cg.clip()
let gradient = CGGradient(
    colorsSpace: CGColorSpaceCreateDeviceRGB(),
    colors: [color(0x101a2c), color(0x02040a)] as CFArray,
    locations: [0, 1]
)
if let gradient {
    cg.drawLinearGradient(
        gradient,
        start: CGPoint(x: tile.midX, y: tile.maxY),
        end: CGPoint(x: tile.midX, y: tile.minY),
        options: []
    )
}
// Hairline rim, the same "line" token the UI uses for edges.
cg.setStrokeColor(color(0xaac8ff, alpha: 0.16))
cg.setLineWidth(size * 0.004)
cg.addPath(tilePath)
cg.strokePath()
cg.restoreGState()

// The mark, drawn in the favicon's 64x64 coordinate space and centred.
cg.saveGState()
cg.translateBy(x: size / 2, y: size / 2)
let unit = size * 0.68 / 64
cg.scaleBy(x: unit, y: unit)
cg.translateBy(x: -32, y: -32)
cg.setLineCap(.round)

// Orbit: an ellipse tilted 24° with a satellite riding it. Core Graphics is
// y-up where SVG is y-down, so the SVG's -24° is +24° here — the satellite
// must sit at the top right, as in the favicon.
cg.saveGState()
cg.translateBy(x: 32, y: 32)
cg.rotate(by: 24 * .pi / 180)
cg.translateBy(x: -32, y: -32)
cg.setStrokeColor(color(0x5ee6a8, alpha: 0.5))
cg.setLineWidth(3.5)
cg.addEllipse(in: CGRect(x: 4, y: 21, width: 56, height: 22))
cg.strokePath()
cg.setFillColor(mint)
cg.fillEllipse(in: CGRect(x: 53.5, y: 27.5, width: 9, height: 9))
cg.restoreGState()

// The ring: openCycle's orbit, and the cycle.
cg.setStrokeColor(mint)
cg.setLineWidth(5)
cg.addEllipse(in: CGRect(x: 19, y: 19, width: 26, height: 26))
cg.strokePath()
cg.restoreGState()

NSGraphicsContext.restoreGraphicsState()

guard let data = rep.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write(Data("make-icon: could not encode the PNG\n".utf8))
    exit(1)
}
do {
    try data.write(to: URL(fileURLWithPath: outPath))
} catch {
    FileHandle.standardError.write(Data("make-icon: \(error.localizedDescription)\n".utf8))
    exit(1)
}
