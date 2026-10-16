// Filedrawer's helper. Answers the questions Electron can't: file icons at
// any size, the name Finder shows for a file (apps without .app, and other
// extensions as the file and Finder's settings say), the Mac's name for a
// file's kind, whether a file is hidden or a
// package (an app or a bundle that opens like a file), and a volume's name
// and free space as Finder counts it.
//
//   filedrawer-helper serve
//
// Reads one JSON request per line on stdin and writes one JSON reply per
// line on stdout, with the request's id:
//   {"id":1,"cmd":"info","paths":["/Users/you/a.txt"]}
//     -> {"id":1,"items":[{"name":"a.txt","kind":"Plain Text Document","hidden":false,"package":false}]}
//   {"id":2,"cmd":"icon","path":"/Applications/Safari.app","size":64}
//     -> {"id":2,"png":"<base64>"}
//   {"id":3,"cmd":"typeIcon","ext":"pdf","size":64}
//     -> {"id":3,"png":"<base64>"}
//   {"id":4,"cmd":"volume","path":"/Users/you"}
//     -> {"id":4,"name":"Macintosh HD","free":195000000000,"total":494000000000}
//   {"id":5,"cmd":"trash","paths":["/Users/you/a.txt"]}
//     -> {"id":5,"items":[{"from":"/Users/you/a.txt","to":"/Users/you/.Trash/a.txt"}]}
//     (an item that couldn't go to the Trash has "error" instead of "to")
//   {"id":6,"cmd":"move","from":"/Users/you/.Trash/a.txt","to":"/Users/you/a.txt"}
//     -> {"id":6,"ok":true}
//   {"id":7,"cmd":"clipWrite","paths":["/Users/you/a.txt"]}
//     -> {"id":7,"change":42}   (the clipboard's change count after writing)
//   {"id":8,"cmd":"clipRead"}
//     -> {"id":8,"paths":["/Users/you/a.txt"],"change":42}
// A request that fails gets {"id":n,"error":"..."}.
import AppKit
import Foundation
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
}

// An icon drawn at size x size pixels, as PNG.
func png(_ image: NSImage, _ size: Int) -> String? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                     bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
    rep.size = NSSize(width: size, height: size)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}

// Kinds are the same for every file with an extension, so they're worked
// out once per extension. Files without one are asked about one by one.
var kindByExt: [String: String] = [:]

func info(_ path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    let keys: Set<URLResourceKey> = [.isHiddenKey, .isPackageKey, .isDirectoryKey, .isSymbolicLinkKey, .localizedTypeDescriptionKey, .localizedNameKey]
    let values = try? url.resourceValues(forKeys: keys)
    let isDir = values?.isDirectory ?? false
    // A link opens what it points at, so a link to an app is a package too,
    // and reads as the app's kind (Safari in /Applications is a link).
    var isPackage = values?.isPackage ?? false
    var linkKind: String? = nil
    if values?.isSymbolicLink == true {
        let target = try? url.resolvingSymlinksInPath().resourceValues(forKeys: [.isPackageKey, .localizedTypeDescriptionKey])
        isPackage = target?.isPackage ?? false
        if isPackage { linkKind = target?.localizedTypeDescription }
    }
    let ext = url.pathExtension.lowercased()
    var kind: String
    if let k = linkKind {
        kind = k
    } else if !isDir && !ext.isEmpty, let known = kindByExt[ext] {
        kind = known
    } else {
        kind = values?.localizedTypeDescription ?? ""
        if !isDir && !ext.isEmpty && !kind.isEmpty { kindByExt[ext] = kind }
    }
    return ["name": values?.localizedName ?? url.lastPathComponent, "kind": kind, "hidden": values?.isHidden ?? false, "package": isPackage]
}

func volume(_ path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    let keys: Set<URLResourceKey> = [.volumeNameKey, .volumeLocalizedNameKey, .volumeAvailableCapacityForImportantUsageKey,
                                     .volumeAvailableCapacityKey, .volumeTotalCapacityKey]
    let v = try? url.resourceValues(forKeys: keys)
    let free = v?.volumeAvailableCapacityForImportantUsage.map { Int($0) } ?? v?.volumeAvailableCapacity ?? 0
    return ["name": v?.volumeLocalizedName ?? v?.volumeName ?? "", "free": free, "total": v?.volumeTotalCapacity ?? 0]
}

func handle(_ req: [String: Any]) {
    let id = req["id"] ?? NSNull()
    let size = max(8, min(1024, req["size"] as? Int ?? 32))
    switch req["cmd"] as? String {
    case "info":
        let paths = req["paths"] as? [String] ?? []
        reply(["id": id, "items": paths.map(info)])
    case "icon":
        guard let path = req["path"] as? String, FileManager.default.fileExists(atPath: path),
              let data = png(NSWorkspace.shared.icon(forFile: path), size) else {
            reply(["id": id, "error": "no icon"])
            return
        }
        reply(["id": id, "png": data])
    case "typeIcon":
        let ext = req["ext"] as? String ?? ""
        let type = UTType(filenameExtension: ext) ?? .data
        guard let data = png(NSWorkspace.shared.icon(for: type), size) else {
            reply(["id": id, "error": "no icon"])
            return
        }
        reply(["id": id, "png": data])
    case "trash":
        let paths = req["paths"] as? [String] ?? []
        let items: [[String: Any]] = paths.map { p in
            var landed: NSURL?
            do {
                try FileManager.default.trashItem(at: URL(fileURLWithPath: p), resultingItemURL: &landed)
                return ["from": p, "to": landed?.path ?? ""]
            } catch {
                return ["from": p, "error": (error as NSError).localizedDescription]
            }
        }
        reply(["id": id, "items": items])
    case "move":
        // Out of the Trash, for Undo. The helper does it so the move counts as
        // Filedrawer's own, the same as the trashing did.
        guard let from = req["from"] as? String, let to = req["to"] as? String else {
            reply(["id": id, "error": "bad move"])
            return
        }
        do {
            try FileManager.default.moveItem(at: URL(fileURLWithPath: from), to: URL(fileURLWithPath: to))
            reply(["id": id, "ok": true])
        } catch {
            reply(["id": id, "error": (error as NSError).localizedDescription])
        }
    case "clipWrite":
        // As file links, the way Finder copies files, so Finder can paste them.
        let urls = (req["paths"] as? [String] ?? []).map { URL(fileURLWithPath: $0) as NSURL }
        let board = NSPasteboard.general
        board.clearContents()
        board.writeObjects(urls)
        reply(["id": id, "change": board.changeCount])
    case "clipRead":
        let board = NSPasteboard.general
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        reply(["id": id, "paths": urls.map { $0.path }, "change": board.changeCount])
    case "volume":
        reply(["id": id].merging(volume(req["path"] as? String ?? "/")) { a, _ in a })
    default:
        reply(["id": id, "error": "unknown command"])
    }
}

func serve() {
    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            reply(["error": "bad request"])
            continue
        }
        autoreleasepool { handle(req) }
    }
}

switch CommandLine.arguments.dropFirst().first {
case "serve":
    serve()
default:
    FileHandle.standardError.write("usage: filedrawer-helper serve\n".data(using: .utf8)!)
    exit(2)
}
