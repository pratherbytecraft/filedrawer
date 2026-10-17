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
//     -> {"id":1,"items":[{"name":"a.txt","kind":"Plain Text Document","hidden":false,"package":false,"added":1760000000000}]}
//     (added: when the item came into its folder, in ms, which in the Trash is when it was deleted)
//   {"id":2,"cmd":"icon","path":"/Applications/Safari.app","size":64}
//     -> {"id":2,"png":"<base64>"}
//   {"id":3,"cmd":"typeIcon","ext":"pdf","size":64}
//     -> {"id":3,"png":"<base64>"}
//   {"id":19,"cmd":"thumb","path":"/Users/you/Beach.jpg","size":96}
//     -> {"id":19,"png":"<base64>","width":96,"height":58}, or {"id":19,"error":"no picture"}
//     (Quick Look's picture of the file in its own shape, the way Finder's icon
//     view draws it; a file Quick Look only has an icon for has no picture)
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
//   {"id":9,"cmd":"openWith","path":"/Users/you/a.txt"}
//     -> {"id":9,"apps":[{"path":"/System/Applications/TextEdit.app","name":"TextEdit","default":true,"claims":true}]}
//     (claims: the app names this kind of file outright, not only any file)
//   {"id":15,"cmd":"setDefault","path":"/Users/you/a.txt","app":"/Applications/BBEdit.app","scope":"type"}
//     -> {"id":15,"ok":true}   (scope type: every file of this kind, file: this file only)
//     macOS asks the user before it changes the app for a whole kind, so the
//     reply comes once that's answered, while other requests carry on.
//   {"id":10,"cmd":"flags","path":"/Users/you/a.txt"}
//     -> {"id":10,"locked":false,"hidden":false,"hideExt":false}
//   {"id":11,"cmd":"setFlags","path":"/Users/you/a.txt","locked":true,"hidden":false,"hideExt":true}
//     -> {"id":11,"ok":true}
//   {"id":16,"cmd":"extra","path":"/Users/you/Downloads/a.txt"}
//     -> {"id":16,"version":"","whereFrom":["https://example.com/a.txt"],"comment":""}
//     (version for apps, whereFrom for downloads, comment is Finder's)
//   {"id":17,"cmd":"lastUsed","paths":["/Users/you/a.txt"]}
//     -> {"id":17,"dates":[1760000000000]}   (when each was last opened, in ms, 0 when never)
//   {"id":18,"cmd":"appNames","ids":["com.apple.Pages"]}
//     -> {"id":18,"names":["Pages"]}   ("" for an app that isn't on this Mac)
//   {"id":12,"cmd":"alias","path":"/Users/you/a.txt","to":"/Users/you/Desktop/a.txt alias"}
//     -> {"id":12,"ok":true}   (a Finder alias, which follows the item when it moves)
//   {"id":13,"cmd":"viewer"}
//     -> {"id":13,"fileViewer":""}   (the app other apps use for Show in Finder, "" for Finder)
//   {"id":14,"cmd":"setViewer","bundleId":"com.pratherbytecraft.filedrawer"}
//     -> {"id":14,"ok":true}   ("" hands it back to Finder)
// macOS doesn't let another app become the one that opens folders (Launch
// Services answers -50 for public.folder), so only Show in Finder can move.
// A request that fails gets {"id":n,"error":"..."}.
//
//   filedrawer-helper watch
//
// Watches Finder so its new folder windows open in Filedrawer instead (see
// FinderWatcher below). Writes one JSON event per line:
//   {"type":"permission","accessibility":true,"automation":"allowed"}
//     (automation is allowed, denied, ask or unknown while Finder isn't running)
//   {"type":"window","token":1,"frame":[x,y,w,h],"title":"Documents"}
//     (Finder opened a window: Filedrawer shows one at that frame right away)
//   {"type":"folder","token":1,"path":"/Users/you/Documents"}
//     (the folder it shows; Finder's window is closed next)
//   {"type":"skip","token":1}
//     (not a folder Filedrawer takes, Finder keeps the window)
//   The Trash, Recents and iCloud Drive's top come as folder events with the
//   paths ::trash, ::recents and ::icloud (the Trash only while Filedrawer
//   can read it, which takes Full Disk Access).
// and reads one command per line:
//   {"cmd":"pass"}            the next Finder window in the next 3 seconds stays Finder's
// Other apps can ask the same by posting the distributed notification
// com.pratherbytecraft.filedrawer.passFinder (Startbar does, when its Start
// menu folders are set to open in Finder).
//   {"cmd":"askAutomation"}   asks the user for Control Finder (macOS shows its prompt once)
//   {"cmd":"askAccessibility"} puts Filedrawer in the Accessibility list and shows macOS's note
import AppKit
import ApplicationServices
import CoreServices
import Foundation
import ImageIO
import Photos
import QuickLookThumbnailing
import UniformTypeIdentifiers

setvbuf(stdout, nil, _IOLBF, 0)

// Replies can come from another thread (setDefault answers once macOS
// does), so lines are written one at a time.
let replyLock = NSLock()

func photosStatus() -> String {
    switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
    case .authorized, .limited: return "allowed"
    case .denied, .restricted: return "denied"
    default: return "unknown"
    }
}

// A video from the Photos library, written into dest under name with the
// extension of its file. The edited version when there is one, else the
// original. The drag's own file is only the poster frame; the video itself
// is a file promise, which another process can't receive.
func videoExport(_ asset: PHAsset, dest: String, name: String, done: @escaping ([String: Any]) -> Void) {
    let resources = PHAssetResource.assetResources(for: asset)
    guard let res = resources.first(where: { $0.type == .fullSizeVideo }) ?? resources.first(where: { $0.type == .video }) else {
        return done(["error": "The video wasn't found in the Photos library."])
    }
    let type = UTType(res.uniformTypeIdentifier)
    let ext = (res.originalFilename as NSString).pathExtension.lowercased()
    let out = ext.isEmpty ? (type?.preferredFilenameExtension ?? "mov") : ext
    let stem = (name as NSString).deletingPathExtension
    let file = URL(fileURLWithPath: dest).appendingPathComponent((stem.isEmpty ? "Video" : stem) + "." + out)
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = true
    PHAssetResourceManager.default().writeData(for: res, toFile: file, options: options) { error in
        if let error { done(["error": error.localizedDescription]) }
        else { done(["path": file.path, "type": res.uniformTypeIdentifier]) }
    }
}

func photoExport(_ id: String, dest: String, name: String, done: @escaping ([String: Any]) -> Void) {
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
        return done(["error": "The photo wasn't found in the Photos library."])
    }
    if asset.mediaType == .video { return videoExport(asset, dest: dest, name: name, done: done) }
    guard asset.mediaType == .image else { return done(["error": "Only pictures and videos are exported."]) }
    let options = PHImageRequestOptions()
    options.version = .current
    options.isNetworkAccessAllowed = true
    options.deliveryMode = .highQualityFormat
    PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { data, uti, _, info in
        guard var data, let uti else {
            let err = (info?[PHImageErrorKey] as? NSError)?.localizedDescription ?? "The photo couldn't be read."
            return done(["error": err])
        }
        var type = UTType(uti) ?? .jpeg
        if type.conforms(to: .heic) || type.conforms(to: .heif) {
            if let source = CGImageSourceCreateWithData(data as CFData, nil) {
                let out = NSMutableData()
                if let sink = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) {
                    CGImageDestinationAddImageFromSource(sink, source, 0, [kCGImageDestinationLossyCompressionQuality: 0.9] as CFDictionary)
                    if CGImageDestinationFinalize(sink) {
                        data = out as Data
                        type = .jpeg
                    }
                }
            }
        }
        let ext = type.preferredFilenameExtension ?? "jpeg"
        let stem = (name as NSString).deletingPathExtension
        let file = URL(fileURLWithPath: dest).appendingPathComponent((stem.isEmpty ? "Photo" : stem) + "." + ext)
        do {
            try data.write(to: file)
            done(["path": file.path, "type": type.identifier])
        } catch {
            done(["error": error.localizedDescription])
        }
    }
}

// Quick Look's picture of a file, at most size x size pixels and in the
// file's own shape: a photo stays wide, a document comes out as its first
// page. Only a real picture counts; when Quick Look would only have the
// file's icon, the answer is "no picture" and Filedrawer keeps its own icon.
func thumbnail(_ path: String, _ size: Int, done: @escaping ([String: Any]) -> Void) {
    guard FileManager.default.fileExists(atPath: path) else { return done(["error": "no picture"]) }
    let request = QLThumbnailGenerator.Request(fileAt: URL(fileURLWithPath: path), size: CGSize(width: size, height: size),
                                               scale: 1, representationTypes: .thumbnail)
    QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { rep, _ in
        guard let rep, rep.type == .thumbnail else { return done(["error": "no picture"]) }
        let image = rep.cgImage
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
            return done(["error": "no picture"])
        }
        done(["png": data.base64EncodedString(), "width": image.width, "height": image.height])
    }
}

func reply(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let line = String(data: data, encoding: .utf8) else { return }
    replyLock.lock()
    print(line)
    replyLock.unlock()
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
    let keys: Set<URLResourceKey> = [.isHiddenKey, .isPackageKey, .isDirectoryKey, .isSymbolicLinkKey, .isAliasFileKey, .localizedTypeDescriptionKey, .localizedNameKey, .addedToDirectoryDateKey]
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
    var out: [String: Any] = ["name": values?.localizedName ?? url.lastPathComponent, "kind": kind, "hidden": values?.isHidden ?? false, "package": isPackage]
    if let added = values?.addedToDirectoryDate { out["added"] = Int(added.timeIntervalSince1970 * 1000) }
    // A Finder alias (not a link) says where it points, so a folder's alias can open that folder.
    if values?.isAliasFile == true && values?.isSymbolicLink != true, let target = try? URL(resolvingAliasFileAt: url, options: [.withoutUI, .withoutMounting]) {
        let t = try? target.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        out["alias"] = target.path
        out["aliasDir"] = (t?.isDirectory ?? false) && !(t?.isPackage ?? false)
    }
    return out
}

func volume(_ path: String) -> [String: Any] {
    let url = URL(fileURLWithPath: path)
    let keys: Set<URLResourceKey> = [.volumeNameKey, .volumeLocalizedNameKey, .volumeAvailableCapacityForImportantUsageKey,
                                     .volumeAvailableCapacityKey, .volumeTotalCapacityKey]
    let v = try? url.resourceValues(forKeys: keys)
    // The important usage figure counts purgeable space like Finder, but it's
    // 0 on disks that aren't APFS, such as HFS+ disk images.
    let important = v?.volumeAvailableCapacityForImportantUsage.map { Int($0) } ?? 0
    let free = max(important, v?.volumeAvailableCapacity ?? 0)
    return ["name": v?.volumeLocalizedName ?? v?.volumeName ?? "", "free": free, "total": v?.volumeTotalCapacity ?? 0]
}

// A Spotlight value Finder keeps on the file itself, such as where a
// download came from, read from its extended attribute.
func metadata(_ path: String, _ key: String) -> Any? {
    let name = "com.apple.metadata:" + key
    let size = getxattr(path, name, nil, 0, 0, 0)
    guard size > 0 else { return nil }
    var data = Data(count: size)
    let read = data.withUnsafeMutableBytes { getxattr(path, name, $0.baseAddress, size, 0, 0) }
    guard read == size else { return nil }
    return try? PropertyListSerialization.propertyList(from: data, format: nil)
}

// Whether an app names this exact kind of file or extension among its
// document types, as opposed to a wider kind (any text, any file).
func claims(_ app: URL, _ file: URL) -> Bool {
    guard let docs = Bundle(url: app)?.infoDictionary?["CFBundleDocumentTypes"] as? [[String: Any]] else { return false }
    let ext = file.pathExtension.lowercased()
    let type = (try? file.resourceValues(forKeys: [.contentTypeKey]))?.contentType
    for doc in docs {
        if !ext.isEmpty, let exts = doc["CFBundleTypeExtensions"] as? [String], exts.contains(where: { $0.lowercased() == ext }) { return true }
        if let type, let ids = doc["LSItemContentTypes"] as? [String], ids.contains(where: { UTType($0) == type }) { return true }
    }
    return false
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
    case "dragNames":
        // The files on the drag pasteboard with the names their app suggests
        // for them (Photos names its originals by id and suggests the real name).
        // A drag from Photos also carries the photo's id in its library and
        // whether it's a picture (1) or a video (2), for photoExport.
        let board = NSPasteboard(name: .drag)
        var items: [[String: Any]] = []
        for item in board.pasteboardItems ?? [] {
            guard let urlText = item.string(forType: .fileURL), let url = URL(string: urlText), url.isFileURL,
                  let name = item.string(forType: NSPasteboard.PasteboardType("com.apple.pasteboard.promised-suggested-file-name")),
                  !name.isEmpty else { continue }
            var entry: [String: Any] = ["path": url.path, "name": name]
            if let data = item.data(forType: NSPasteboard.PasteboardType("com.apple.photos.object-reference.asset")),
               let ref = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
               let asset = ref["localIdentifier"] as? String {
                entry["asset"] = asset
                entry["mediaType"] = ref["mediaType"] as? Int ?? 0
            }
            items.append(entry)
        }
        reply(["id": id, "items": items, "change": board.changeCount])
    case "thumb":
        thumbnail(req["path"] as? String ?? "", size) { result in reply(["id": id].merging(result) { a, _ in a }) }
    case "photosStatus":
        reply(["id": id, "status": photosStatus()])
    case "askPhotos":
        // macOS's Photos prompt. The answer comes back when it's closed.
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { _ in reply(["id": id, "status": photosStatus()]) }
    case "photoExport":
        // The current version of a photo or video in the Photos library,
        // written into dest under name (with the extension of what comes
        // out). HEIC comes out as JPEG, the way Photos exports it for Finder.
        let asset = req["asset"] as? String ?? ""
        let dest = req["dest"] as? String ?? ""
        let name = req["name"] as? String ?? "Photo"
        photoExport(asset, dest: dest, name: name) { result in reply(["id": id].merging(result) { a, _ in a }) }
    case "clipRead":
        let board = NSPasteboard.general
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        reply(["id": id, "paths": urls.map { $0.path }, "change": board.changeCount])
    case "openWith":
        let url = URL(fileURLWithPath: req["path"] as? String ?? "/")
        let fallback = NSWorkspace.shared.urlForApplication(toOpen: url)
        var seen = Set<String>()
        var apps: [[String: Any]] = []
        for app in NSWorkspace.shared.urlsForApplications(toOpen: url) where !seen.contains(app.path) {
            seen.insert(app.path)
            apps.append(["path": app.path, "name": FileManager.default.displayName(atPath: app.path), "default": app == fallback, "claims": claims(app, url)])
        }
        reply(["id": id, "apps": apps])
    case "setDefault":
        let file = URL(fileURLWithPath: req["path"] as? String ?? "/")
        let app = URL(fileURLWithPath: req["app"] as? String ?? "/")
        let finished: (Error?) -> Void = { err in
            if let err = err as NSError? {
                reply(["id": id, "error": err.localizedDescription, "code": err.code, "domain": err.domain])
            } else {
                reply(["id": id, "ok": true])
            }
        }
        if req["scope"] as? String == "file" {
            NSWorkspace.shared.setDefaultApplication(at: app, toOpenFileAt: file, completion: finished)
        } else {
            NSWorkspace.shared.setDefaultApplication(at: app, toOpenContentTypeOfFileAt: file, completion: finished)
        }
    case "flags":
        let v = try? URL(fileURLWithPath: req["path"] as? String ?? "/").resourceValues(forKeys: [.isUserImmutableKey, .isHiddenKey, .hasHiddenExtensionKey])
        reply(["id": id, "locked": v?.isUserImmutable ?? false, "hidden": v?.isHidden ?? false, "hideExt": v?.hasHiddenExtension ?? false])
    case "setFlags":
        var url = URL(fileURLWithPath: req["path"] as? String ?? "/")
        var values = URLResourceValues()
        if let locked = req["locked"] as? Bool { values.isUserImmutable = locked }
        if let hidden = req["hidden"] as? Bool { values.isHidden = hidden }
        if let hideExt = req["hideExt"] as? Bool { values.hasHiddenExtension = hideExt }
        do {
            try url.setResourceValues(values)
            reply(["id": id, "ok": true])
        } catch {
            reply(["id": id, "error": (error as NSError).localizedDescription])
        }
    case "extra":
        let path = req["path"] as? String ?? "/"
        let version = Bundle(path: path).flatMap { b -> String? in
            guard b.bundleURL.pathExtension == "app", let short = b.infoDictionary?["CFBundleShortVersionString"] as? String else { return nil }
            let build = b.infoDictionary?["CFBundleVersion"] as? String
            return build != nil && build != short ? "\(short) (\(build!))" : short
        } ?? ""
        let whereFrom = (metadata(path, "kMDItemWhereFroms") as? [String] ?? []).filter { !$0.isEmpty }
        reply(["id": id, "version": version, "whereFrom": whereFrom, "comment": metadata(path, "kMDItemFinderComment") as? String ?? ""])
    case "lastUsed":
        let dates: [Int] = (req["paths"] as? [String] ?? []).map { p in
            guard let item = MDItemCreate(nil, p as CFString),
                  let date = MDItemCopyAttribute(item, kMDItemLastUsedDate) as? Date else { return 0 }
            return Int(date.timeIntervalSince1970 * 1000)
        }
        reply(["id": id, "dates": dates])
    case "appNames":
        let names: [String] = (req["ids"] as? [String] ?? []).map { bundle in
            guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { return "" }
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        reply(["id": id, "names": names])
    case "alias":
        do {
            let src = URL(fileURLWithPath: req["path"] as? String ?? "")
            let data = try src.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(data, to: URL(fileURLWithPath: req["to"] as? String ?? ""))
            reply(["id": id, "ok": true])
        } catch {
            reply(["id": id, "error": (error as NSError).localizedDescription])
        }
    case "viewer":
        let viewer = CFPreferencesCopyAppValue("NSFileViewer" as CFString, kCFPreferencesAnyApplication) as? String ?? ""
        reply(["id": id, "fileViewer": viewer])
    case "setViewer":
        // Finder is what apps use when nothing is set, so going back takes the setting out.
        let bundle = req["bundleId"] as? String ?? ""
        let value: CFString? = bundle.isEmpty || bundle == "com.apple.finder" ? nil : bundle as CFString
        CFPreferencesSetAppValue("NSFileViewer" as CFString, value, kCFPreferencesAnyApplication)
        if CFPreferencesAppSynchronize(kCFPreferencesAnyApplication) {
            reply(["id": id, "ok": true])
        } else {
            reply(["id": id, "error": "the setting couldn't be saved"])
        }
    case "volume":
        reply(["id": id].merging(volume(req["path"] as? String ?? "/")) { a, _ in a })
    default:
        reply(["id": id, "error": "unknown command"])
    }
}

// Requests come in on a background thread and run on the main thread, with
// its run loop going for the answers that come back later, such as Photos'.
func serve() {
    Thread.detachNewThread {
        while let line = readLine(strippingNewline: true) {
            guard let data = line.data(using: .utf8),
                  let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                reply(["error": "bad request"])
                continue
            }
            DispatchQueue.main.async { autoreleasepool { handle(req) } }
        }
        // Filedrawer closed our stdin or quit.
        DispatchQueue.main.async { exit(0) }
    }
    RunLoop.main.run()
}

// ---------- watch: Finder's new windows open in Filedrawer ----------

// When Finder opens a folder window, Filedrawer opens one in the same spot
// and Finder's closes underneath. Finder only says a window opened after
// it's drawn, so the frame goes out first and Filedrawer covers the window
// within a few frames; asking Finder which folder it shows takes longer.
// Windows that aren't folders on disk stay Finder's.
final class FinderWatcher {
    var trusted = AXIsProcessTrusted()
    var automation = "unknown"
    var observer: AXObserver?
    var finderPid: pid_t = 0
    var known: [AXUIElement] = []
    var token = 0
    var passUntil = Date.distantPast
    var attachedOnce = false
    // The windows Finder brings back when it starts (a login or a restart)
    // close instead of moving over, so nothing opens on its own.
    var restored: [AXUIElement] = []
    var restoringUntil = Date.distantPast

    // Places that aren't a folder on disk, by the title Finder gives them.
    static let skipTitles: Set<String> = ["AirDrop", "Network", "Computer"]
    // Places Filedrawer shows itself, by the same titles.
    static let places: [String: String] = ["Trash": "::trash", "Recents": "::recents", "iCloud Drive": "::icloud"]

    // The Trash can be listed once Filedrawer has Full Disk Access.
    func canReadTrash() -> Bool {
        (try? FileManager.default.contentsOfDirectory(atPath: NSHomeDirectory() + "/.Trash")) != nil
    }

    func start() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.0)
        // An Accessibility call from an app that isn't allowed yet puts it in
        // the list in System Settings, switched off, ready to turn on.
        if !trusted {
            var v: AnyObject?
            AXUIElementCopyAttributeValue(AXUIElementCreateSystemWide(), kAXFocusedApplicationAttribute as CFString, &v)
        }
        checkAutomation()
        emitPermission()
        attach()
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] note in
            let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            if app?.bundleIdentifier == "com.apple.finder" { self?.attach() }
        }
        // A permission given or taken away in System Settings, and Finder
        // coming back after a restart.
        Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            let now = AXIsProcessTrusted()
            let before = self.automation
            self.checkAutomation()
            if now != self.trusted || before != self.automation {
                self.trusted = now
                self.emitPermission()
                self.attach()
            }
            if self.finderPid == 0 || NSRunningApplication(processIdentifier: self.finderPid) == nil { self.attach() }
        }
        // Another app opening a folder in Finder on purpose.
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.pratherbytecraft.filedrawer.passFinder"), object: nil, queue: .main) { [weak self] _ in
            self?.passUntil = Date().addingTimeInterval(3)
        }
        readCommands()
    }

    func emitPermission() {
        reply(["type": "permission", "accessibility": trusted, "automation": automation])
    }

    func finder() -> NSRunningApplication? {
        NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first
    }

    func checkAutomation() {
        automation = automationStatus(ask: false)
    }

    // Asking with ask false only reads the answer, it never shows the prompt.
    func automationStatus(ask: Bool) -> String {
        guard finder() != nil else { return "unknown" }
        var target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.finder").aeDesc!.pointee
        switch AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, ask) {
        case noErr: return "allowed"
        case OSStatus(errAEEventNotPermitted): return "denied"
        case OSStatus(errAEEventWouldRequireUserConsent): return "ask"
        default: return "unknown"
        }
    }

    func attach() {
        guard trusted, let app = finder() else {
            if observer != nil { dropObserver() }
            return
        }
        if app.processIdentifier == finderPid && observer != nil { return }
        dropObserver()
        finderPid = app.processIdentifier
        let element = AXUIElementCreateApplication(finderPid)
        guard AXObserverCreate(finderPid, { _, el, _, refcon in
            let me = Unmanaged<FinderWatcher>.fromOpaque(refcon!).takeUnretainedValue()
            me.created(el)
        }, &observer) == .success, let observer else { return }
        AXObserverAddNotification(observer, element, kAXWindowCreatedNotification as CFString, Unmanaged.passUnretained(self).toOpaque())
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        let windows = attr(element, kAXWindowsAttribute) as? [AXUIElement] ?? []
        // Finder's windows when Filedrawer starts are left alone, unless
        // Finder itself just started (a login or a restart brings its last
        // windows back), and then they close. Windows Finder brings back in
        // its first seconds close too, later ones move over as usual.
        let launched = started(app)
        let restoring = Date().timeIntervalSince(launched) < 30
        let fresh = attachedOnce || restoring
        attachedOnce = true
        known = fresh ? [] : windows
        restored = restoring ? windows : []
        restoringUntil = restoring ? launched.addingTimeInterval(20) : .distantPast
        if fresh {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                guard let self else { return }
                for w in attr(element, kAXWindowsAttribute) as? [AXUIElement] ?? [] { self.created(w) }
            }
        }
    }

    // When the app started. Finder has no launchDate (launchd starts it,
    // not Launch Services), so its start time comes from the kernel.
    func started(_ app: NSRunningApplication) -> Date {
        if let date = app.launchDate { return date }
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, app.processIdentifier]
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return .distantPast }
        let tv = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: Double(tv.tv_sec) + Double(tv.tv_usec) / 1_000_000)
    }

    func dropObserver() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode) }
        observer = nil
        finderPid = 0
        known = []
    }

    func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var v: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
    }

    func frame(_ win: AXUIElement) -> [Int]? {
        guard let pv = attr(win, kAXPositionAttribute), let sv = attr(win, kAXSizeAttribute) else { return nil }
        var p = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &size) else { return nil }
        return [Int(p.x), Int(p.y), Int(size.width), Int(size.height)]
    }

    // Browser windows have a toolbar. Get Info and copy progress don't.
    func isBrowser(_ win: AXUIElement) -> Bool {
        guard attr(win, kAXSubroleAttribute) as? String == kAXStandardWindowSubrole as String else { return false }
        let kids = attr(win, kAXChildrenAttribute) as? [AXUIElement] ?? []
        return kids.contains { attr($0, kAXRoleAttribute) as? String == kAXToolbarRole as String }
    }

    // Closes a folder window Finder brought back. Finder says the window
    // opened before its title and toolbar are there, and can miss a press
    // while it sets the window up, so it looks again for a few seconds.
    // Other windows, such as Get Info, stay.
    func closeRestored(_ win: AXUIElement, tries: Int = 20) {
        guard tries > 0, attr(win, kAXRoleAttribute) != nil else { return }
        if isBrowser(win), let close = attr(win, kAXCloseButtonAttribute) {
            AXUIElementPerformAction(close as! AXUIElement, kAXPressAction as CFString)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.closeRestored(win, tries: tries - 1)
        }
    }

    func created(_ win: AXUIElement) {
        guard !known.contains(where: { CFEqual($0, win) }) else { return }
        known.append(win)
        known = known.filter { attr($0, kAXRoleAttribute) != nil } // drops closed ones
        guard automation == "allowed" else { return }
        if Date() < restoringUntil || restored.contains(where: { CFEqual($0, win) }) {
            restored.removeAll { CFEqual($0, win) }
            closeRestored(win)
            return
        }
        guard isBrowser(win) else { return }
        if Date() < passUntil {
            passUntil = .distantPast
            return
        }
        if CGEventSource.flagsState(.combinedSessionState).contains(.maskAlternate) { return }
        let title = attr(win, kAXTitleAttribute) as? String ?? ""
        guard !title.isEmpty, !Self.skipTitles.contains(title), let frame = frame(win) else { return }
        if let place = Self.places[title], place != "::trash" || canReadTrash() {
            token += 1
            reply(["type": "window", "token": token, "frame": frame, "title": title])
            reply(["type": "folder", "token": token, "path": place])
            if let close = attr(win, kAXCloseButtonAttribute) {
                AXUIElementPerformAction(close as! AXUIElement, kAXPressAction as CFString)
            }
            return
        }
        if Self.places[title] != nil { return }
        token += 1
        let t = token
        reply(["type": "window", "token": t, "frame": frame, "title": title])
        if let path = folder(titled: title), take(path) {
            reply(["type": "folder", "token": t, "path": path])
            if let close = attr(win, kAXCloseButtonAttribute) {
                AXUIElementPerformAction(close as! AXUIElement, kAXPressAction as CFString)
            }
        } else {
            reply(["type": "skip", "token": t])
            finder()?.activate()
        }
    }

    // The folder Finder's window with this title shows, or nil for places
    // that aren't folders (AppleScript can't make those an alias).
    func folder(titled title: String) -> String? {
        let quoted = title.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let src = "tell application \"Finder\" to get POSIX path of (target of (first Finder window whose name is \"\(quoted)\") as alias)"
        var err: NSDictionary?
        guard let out = NSAppleScript(source: src)?.executeAndReturnError(&err).stringValue else {
            if (err?[NSAppleScript.errorNumber] as? Int) == Int(errAEEventNotPermitted) {
                automation = "denied"
                emitPermission()
            }
            return nil
        }
        return out.count > 1 && out.hasSuffix("/") ? String(out.dropLast()) : out
    }

    // The Trash and iCloud Drive's top level stay Finder's.
    func take(_ path: String) -> Bool {
        let home = NSHomeDirectory()
        let keep = [home + "/.Trash", home + "/Library/Mobile Documents", home + "/Library/Mobile Documents/com~apple~CloudDocs"]
        if keep.contains(path) || path.hasPrefix(home + "/.Trash/") || path.contains("/.Trashes") { return false }
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: path, isDirectory: &isDir) && isDir.boolValue
    }

    func readCommands() {
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                DispatchQueue.main.async { self.handle(line) }
            }
            // Filedrawer closed our stdin or quit.
            DispatchQueue.main.async { exit(0) }
        }
    }

    func handle(_ line: String) {
        guard let data = line.data(using: .utf8),
              let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch req["cmd"] as? String {
        case "pass":
            passUntil = Date().addingTimeInterval(3)
        case "askAccessibility":
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case "askAutomation":
            // The prompt blocks until it's answered, so it runs off the main thread.
            DispatchQueue.global().async {
                let answer = self.automationStatus(ask: true)
                DispatchQueue.main.async {
                    self.automation = answer
                    self.emitPermission()
                    self.attach()
                }
            }
        default:
            break
        }
    }
}

switch CommandLine.arguments.dropFirst().first {
case "serve":
    serve()
case "watch":
    let watcher = FinderWatcher()
    watcher.start()
    RunLoop.main.run()
default:
    FileHandle.standardError.write("usage: filedrawer-helper serve | watch\n".data(using: .utf8)!)
    exit(2)
}
