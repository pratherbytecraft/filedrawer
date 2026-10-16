// Draws the Filedrawer app icon into an .iconset folder.
// Run from the repo root:
//   swift design/draw-icon.swift /tmp/Filedrawer.iconset
//   iconutil -c icns /tmp/Filedrawer.iconset -o assets/Filedrawer.icns
// The icon is a filing cabinet on a blue tile, its top drawer pulled out
// with three folder tabs standing up in it.
import AppKit

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Filedrawer.iconset"
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(red: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: a)
}

func rounded(_ r: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

func gradient(_ ctx: CGContext, _ colors: [CGColor], from: CGPoint, to: CGPoint) {
    let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: nil)!
    ctx.drawLinearGradient(g, start: from, end: to, options: [])
}

func fill(_ ctx: CGContext, _ path: CGPath, _ colors: [CGColor], top: CGFloat, bottom: CGFloat) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    gradient(ctx, colors, from: CGPoint(x: 0, y: top), to: CGPoint(x: 0, y: bottom))
    ctx.restoreGState()
}

// Everything is drawn on a 1024 canvas, origin bottom left, then scaled.
func draw(_ ctx: CGContext) {
    let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
    let tilePath = rounded(tile, 185)

    // Soft shadow under the tile, like the system icons.
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 28, color: rgb(0x000000, 0.30))
    ctx.addPath(tilePath)
    ctx.setFillColor(rgb(0x0a64d8))
    ctx.fillPath()
    ctx.restoreGState()
    fill(ctx, tilePath, [rgb(0x5ac8fa), rgb(0x0a84ff), rgb(0x0a5bd0)], top: 924, bottom: 100)

    // The cabinet.
    let cabinet = CGRect(x: 262, y: 170, width: 500, height: 560)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 26, color: rgb(0x002a66, 0.40))
    ctx.addPath(rounded(cabinet, 36))
    ctx.setFillColor(rgb(0xd9a75a))
    ctx.fillPath()
    ctx.restoreGState()
    fill(ctx, rounded(cabinet, 36), [rgb(0xf0c37a), rgb(0xc98f3a)], top: cabinet.maxY, bottom: cabinet.minY)

    // The bottom drawer, shut, with its handle.
    let lower = CGRect(x: 300, y: 210, width: 424, height: 214)
    ctx.addPath(rounded(lower, 22))
    ctx.setFillColor(rgb(0xe8b46a))
    ctx.fillPath()
    ctx.addPath(rounded(lower, 22))
    ctx.setStrokeColor(rgb(0x8a5a1c, 0.55))
    ctx.setLineWidth(6)
    ctx.strokePath()
    ctx.addPath(rounded(CGRect(x: 452, y: 300, width: 120, height: 34), 17))
    ctx.setFillColor(rgb(0x6b4512))
    ctx.fillPath()

    // The top drawer's opening, dark inside.
    let opening = CGRect(x: 300, y: 464, width: 424, height: 226)
    ctx.addPath(rounded(opening, 22))
    ctx.setFillColor(rgb(0x5a3a10))
    ctx.fillPath()

    // Folder tabs standing up in the drawer, back to front.
    let folders: [(CGFloat, CGFloat, UInt32, UInt32)] = [
        (330, 690, 0x9fd3ff, 0x5aa9ee),
        (420, 664, 0xfde79a, 0xf1c447),
        (360, 636, 0xa8e38a, 0x4fb53a)
    ]
    for (x, top, light, dark) in folders {
        let body = CGMutablePath()
        body.move(to: CGPoint(x: x, y: 560))
        body.addLine(to: CGPoint(x: x, y: top - 40))
        body.addLine(to: CGPoint(x: x + 30, y: top - 40))
        body.addLine(to: CGPoint(x: x + 50, y: top))
        body.addLine(to: CGPoint(x: x + 150, y: top))
        body.addLine(to: CGPoint(x: x + 170, y: top - 40))
        body.addLine(to: CGPoint(x: x + 334, y: top - 40))
        body.addLine(to: CGPoint(x: x + 334, y: 560))
        body.closeSubpath()
        ctx.saveGState()
        ctx.setShadow(offset: CGSize(width: 0, height: -4), blur: 10, color: rgb(0x000000, 0.30))
        ctx.addPath(body)
        ctx.setFillColor(rgb(dark))
        ctx.fillPath()
        ctx.restoreGState()
        fill(ctx, body, [rgb(light), rgb(dark)], top: top, bottom: 560)
    }

    // The drawer front, pulled out a little past the cabinet.
    let front = CGRect(x: 280, y: 448, width: 464, height: 124)
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 14, color: rgb(0x3a2408, 0.45))
    ctx.addPath(rounded(front, 24))
    ctx.setFillColor(rgb(0xe8b46a))
    ctx.fillPath()
    ctx.restoreGState()
    fill(ctx, rounded(front, 24), [rgb(0xf6cc88), rgb(0xd99d4a)], top: front.maxY, bottom: front.minY)
    ctx.addPath(rounded(front, 24))
    ctx.setStrokeColor(rgb(0x8a5a1c, 0.55))
    ctx.setLineWidth(6)
    ctx.strokePath()
    ctx.addPath(rounded(CGRect(x: 452, y: 494, width: 120, height: 34), 17))
    ctx.setFillColor(rgb(0x6b4512))
    ctx.fillPath()
}

let sizes: [(String, Int)] = [
    ("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64),
    ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512),
    ("icon_512x512", 512), ("icon_512x512@2x", 1024)
]
for (name, px) in sizes {
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.scaleBy(x: CGFloat(px) / 1024, y: CGFloat(px) / 1024)
    draw(ctx)
    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
}
print("Wrote \(sizes.count) images to \(out)")
