// openCycle.app — native launcher.
//
// The bundle exists for one reason: macOS only grants Bluetooth access to a
// process whose responsible app bundle carries NSBluetoothAlwaysUsageDescription.
// This executable starts the openCycle server as its own child (so the child
// inherits the app's TCC identity), waits for it to listen on :4000, opens the
// browser, and shuts the server down gracefully when the app quits.
//
// Build with packaging/macos/build.sh; the repo path is baked into the bundle's
// Info.plist at build time (OCRepoPath), so the app works from any clone
// location as long as that checkout stays where it was.

import AppKit
import Foundation

// MARK: - Constants

let rideURL = URL(string: "http://localhost:4000")!
let healthURL = URL(string: "http://127.0.0.1:4000/healthz")!
let launchTimeout: TimeInterval = 60
let killGrace: TimeInterval = 10

// MARK: - Log file

/**
 * A file handle that always appends. The app and the server child write to the
 * same log, so both sides need O_APPEND: without it each handle keeps its own
 * offset and one clobbers the other's lines.
 */
func appendFileHandle(_ path: String) -> FileHandle? {
    let descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND, 0o644)
    guard descriptor >= 0 else { return nil }
    return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
}

final class LogFile {
    let path: String
    private let handle: FileHandle
    private let formatter: DateFormatter

    init?(path: String) {
        self.path = path
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Fresh log per launch: yesterday's failures are not this launch's story.
        try? Data().write(to: url)
        guard let handle = appendFileHandle(path) else { return nil }
        self.handle = handle
        formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
    }

    func write(_ message: String) {
        let line = "[\(formatter.string(from: Date()))] \(message)\n"
        if let data = line.data(using: .utf8) { handle.write(data) }
    }

    /** Last `count` lines of the file, for crash alerts. */
    func tail(_ count: Int) -> String {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return "(no log yet)" }
        return text.split(separator: "\n", omittingEmptySubsequences: true).suffix(count).joined(separator: "\n")
    }
}

// MARK: - Node lookup

/** Runs a command and returns its trimmed stdout, or nil when it fails. */
func shellOutput(_ launchPath: String, _ arguments: [String], environment: [String: String]? = nil) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    if let environment { process.environment = environment }
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { return nil }
    return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
}

/** True for a path that exists and is executable. */
func isExecutable(_ path: String) -> Bool {
    FileManager.default.isExecutableFile(atPath: path)
}

/** True for `v24.16.0` and newer: the server's native Bluetooth addon needs 24. */
func isNode24OrNewer(_ version: String) -> Bool {
    let cleaned = version.hasPrefix("v") ? version.dropFirst() : Substring(version)
    guard let major = Int(cleaned.split(separator: ".").first ?? "") else { return false }
    return major >= 24
}

/**
 * Node 24, preferring the versions Ryan actually has installed: the nvm
 * default alias, then the newest nvm Node, then Homebrew, then /usr/local,
 * then whatever a login shell resolves (fnm/asdf/volta). Candidates that are
 * older than 24 are skipped rather than handed to a server that needs 24.
 */
func findNode() -> String? {
    let home = NSHomeDirectory()
    var candidates: [String] = []

    let nvmRoot = "\(home)/.nvm/versions/node"
    if let defaultAlias = try? String(contentsOfFile: "\(home)/.nvm/alias/default", encoding: .utf8) {
        let alias = defaultAlias.trimmingCharacters(in: .whitespacesAndNewlines)
        if !alias.isEmpty, alias != "lts/*", alias != "node" {
            let version = alias.hasPrefix("v") ? alias : "v\(alias)"
            candidates.append("\(nvmRoot)/\(version)/bin/node")
        }
    }
    let installed = (try? FileManager.default.contentsOfDirectory(atPath: nvmRoot)) ?? []
    let v24 = installed.filter { $0.hasPrefix("v24.") }.sorted(by: versionDescending)
    let vOther = installed.filter { $0.hasPrefix("v") }.sorted(by: versionDescending)
    candidates.append(contentsOf: (v24 + vOther).map { "\(nvmRoot)/\($0)/bin/node" })

    candidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node"])

    let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
    if let found = shellOutput(shell, ["-lc", "command -v node"]) { candidates.append(found) }

    for candidate in candidates where isExecutable(candidate) {
        if let version = shellOutput(candidate, ["-v"]), isNode24OrNewer(version) { return candidate }
    }
    return nil
}

/** Highest version first: v24.16.0 > v24.9.0 > v22.1.0. */
func versionDescending(_ a: String, _ b: String) -> Bool {
    a.compare(b, options: .numeric) == .orderedDescending
}

// MARK: - App delegate

final class Launcher: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var log: LogFile?
    private var server: Process?
    private var quitting = false
    private var externalServer = false

    let repoPath: String
    let sim: String?
    let ble: Bool
    let dataDir: String?
    let oneShot: String?

    override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        let baked = info["OCRepoPath"] as? String
        var repo = baked ?? FileManager.default.currentDirectoryPath
        var sim = info["OCSim"] as? String
        var ble = (info["OCBle"] as? Bool) ?? true
        var dataDir = info["OCDataDir"] as? String
        var oneShot: String?

        var arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first?.hasPrefix("-psn_") == true { arguments.removeFirst() }
        var index = 0
        while index < arguments.count {
            let arg = arguments[index]
            let value = index + 1 < arguments.count ? arguments[index + 1] : nil
            let takesValue = ["--repo", "--data-dir", "--exec"].contains(arg)
            if takesValue, let value {
                if arg == "--repo" { repo = value }
                if arg == "--data-dir" { dataDir = value }
                if arg == "--exec" { oneShot = value }
                index += 2
                continue
            }
            if arg == "--no-ble" { ble = false }
            if arg == "--ble" { ble = true }
            if arg == "--sim" { sim = "2x2" }
            if arg.hasPrefix("--sim=") { sim = String(arg.dropFirst("--sim=".count)) }
            if arg.hasPrefix("--repo=") { repo = String(arg.dropFirst("--repo=".count)) }
            if arg.hasPrefix("--data-dir=") { dataDir = String(arg.dropFirst("--data-dir=".count)) }
            if arg.hasPrefix("--exec=") { oneShot = String(arg.dropFirst("--exec=".count)) }
            index += 1
        }

        // Environment wins only when it is explicit (a terminal launch); `open`
        // does not forward the shell environment, so Info.plist values carry the
        // build-time defaults.
        let env = ProcessInfo.processInfo.environment
        if let value = env["OPENCYCLE_SIM"], !value.isEmpty { sim = value }
        if env["OPENCYCLE_BLE"] == "0" { ble = false }
        if let value = env["OPENCYCLE_DATA_DIR"], !value.isEmpty { dataDir = value }

        repoPath = URL(fileURLWithPath: repo).standardizedFileURL.path
        self.sim = sim
        self.ble = ble
        self.dataDir = dataDir
        self.oneShot = oneShot
        super.init()
    }

    // MARK: Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        let logPath = "\(NSHomeDirectory())/Library/Logs/openCycle/server.log"
        log = LogFile(path: logPath)
        log?.write("openCycle.app launched (repo: \(repoPath), sim: \(sim ?? "off"), ble: \(ble), exec: \(oneShot ?? "no"))")

        buildMenuBar()
        buildMainMenu()
        NSApp.activate(ignoringOtherApps: true)

        guard FileManager.default.fileExists(atPath: "\(repoPath)/apps/server/src/index.ts") else {
            failLaunch("openCycle's repo folder is missing",
                       "openCycle.app was built from:\n\(repoPath)\n\nThat folder is gone or moved. Rebuild the app from the new location with:\n\ncd <repo> && pnpm app")
            return
        }
        if oneShot != nil { runOneShot() } else { runServer() }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.isRunning, !quitting else { return .terminateNow }
        quitting = true
        log?.write("quit requested; sending SIGTERM to pid \(server.processIdentifier)")
        server.terminate()
        DispatchQueue.global().async { [weak self] in
            let deadline = Date().addingTimeInterval(killGrace)
            while server.isRunning && Date() < deadline { usleep(100_000) }
            if server.isRunning {
                self?.log?.write("server did not exit in \(Int(killGrace))s; sending SIGKILL")
                kill(server.processIdentifier, SIGKILL)
            } else {
                self?.log?.write("server exited cleanly (\(server.terminationStatus))")
            }
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Belt and braces for a hard quit path (logout, SIGKILL of the app).
        if let server, server.isRunning {
            server.terminate()
            kill(server.processIdentifier, SIGKILL)
        }
        log?.write("openCycle.app terminated")
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        openRide()
        return true
    }

    // MARK: Server

    private var serverDirectory: String { "\(repoPath)/apps/server" }

    private func runServer() {
        if waitForHealth(seconds: 1) {
            externalServer = true
            log?.write(":4000 already answers /healthz — another openCycle is running; opening the browser")
            openRide()
            return
        }
        guard let node = findNode() else {
            failLaunch("Node 24 is required",
                       "openCycle needs Node 24 (nvm, Homebrew or /usr/local). Install it, then relaunch openCycle.\n\nnvm: nvm install 24\nHomebrew: brew install node@24")
            return
        }
        let version = shellOutput(node, ["-v"]) ?? "unknown"
        log?.write("using node \(version) at \(node)")

        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(URL(fileURLWithPath: node).deletingLastPathComponent().path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["NODE_ENV"] = "production"
        environment["OPENCYCLE_WEB_DIR"] = "\(repoPath)/apps/web/dist"
        environment["OPENCYCLE_BLE"] = ble ? "1" : "0"
        if let sim { environment["OPENCYCLE_SIM"] = sim }
        if let dataDir { environment["OPENCYCLE_DATA_DIR"] = dataDir }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        // tsx runs inside the server process (no wrapper to swallow signals),
        // so the SIGTERM below reaches the server's own handler.
        process.arguments = ["--import", "tsx", "src/index.ts"]
        process.currentDirectoryURL = URL(fileURLWithPath: serverDirectory)
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        if let handle = logHandle() {
            process.standardOutput = handle
            process.standardError = handle
        }
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.serverExited(finished) }
        }

        do {
            try process.run()
        } catch {
            failLaunch("Could not start the openCycle server", error.localizedDescription)
            return
        }
        server = process
        log?.write("starting server: \(node) --import tsx src/index.ts (pid \(process.processIdentifier))")

        DispatchQueue.global().async { [weak self] in
            guard let self else { return }
            if waitForHealth(seconds: launchTimeout) {
                log?.write("server is answering on :4000")
                DispatchQueue.main.async { self.openRide() }
            } else if process.isRunning {
                DispatchQueue.main.async {
                    self.failLaunch("openCycle did not start in \(Int(launchTimeout))s",
                                    "The server is running but never answered on :4000.\n\n\(self.log?.tail(15) ?? "")")
                }
            }
        }
    }

    private func logHandle() -> FileHandle? {
        guard let path = log?.path else { return nil }
        return appendFileHandle(path)
    }

    private func serverExited(_ process: Process) {
        log?.write("server exited with status \(process.terminationStatus)")
        guard !quitting, !externalServer else { return }
        failLaunch("openCycle's server stopped",
                   "Exit status \(process.terminationStatus). Is another program using port 4000?\n\n\(log?.tail(15) ?? "")")
    }

    private func runOneShot() {
        guard let oneShot else { return }
        guard let node = findNode() else {
            failLaunch("Node 24 is required", "openCycle needs Node 24 to run one-off commands.")
            return
        }
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "\(URL(fileURLWithPath: node).deletingLastPathComponent().path):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        environment["OPENCYCLE_BLE"] = ble ? "1" : "0"
        if let dataDir { environment["OPENCYCLE_DATA_DIR"] = dataDir }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", oneShot]
        process.currentDirectoryURL = URL(fileURLWithPath: repoPath)
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        if let handle = logHandle() {
            process.standardOutput = handle
            process.standardError = handle
        }
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async {
                self?.log?.write("one-off command exited with status \(finished.terminationStatus)")
                NSApp.terminate(nil)
            }
        }
        do {
            try process.run()
            server = process
            log?.write("running one-off command: \(oneShot)")
        } catch {
            failLaunch("Could not run the command", error.localizedDescription)
        }
    }

    // MARK: Health

    private func waitForHealth(seconds: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if healthStatus() == 200 { return true }
            if let server, !server.isRunning, !externalServer { return false }
            usleep(400_000)
        }
        return false
    }

    private func healthStatus() -> Int? {
        let semaphore = DispatchSemaphore(value: 0)
        var status: Int?
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 2
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { _, response, _ in
            status = (response as? HTTPURLResponse)?.statusCode
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 3)
        return status
    }

    // MARK: UI

    private func buildMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "figure.outdoor.cycle", accessibilityDescription: "openCycle")
        item.button?.image?.isTemplate = true

        let menu = NSMenu()
        menu.addItem(menuItem("Open openCycle", #selector(openRide), "o"))
        menu.addItem(menuItem("Show logs", #selector(showLogs), "l"))
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit openCycle", #selector(quit), "q"))
        item.menu = menu
        statusItem = item
    }

    private func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(menuItem("Open openCycle", #selector(openRide), "o"))
        appMenu.addItem(menuItem("Show logs", #selector(showLogs), "l"))
        appMenu.addItem(.separator())
        appMenu.addItem(menuItem("Quit openCycle", #selector(quit), "q"))
        appItem.submenu = appMenu
        main.addItem(appItem)
        NSApp.mainMenu = main
    }

    private func menuItem(_ title: String, _ action: Selector, _ key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func openRide() {
        NSWorkspace.shared.open(rideURL)
    }

    @objc private func showLogs() {
        guard let path = log?.path else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    private func failLaunch(_ title: String, _ body: String) {
        log?.write("ERROR: \(title) — \(body.replacingOccurrences(of: "\n", with: " | "))")
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = title
        alert.informativeText = body
        alert.addButton(withTitle: "Quit openCycle")
        alert.addButton(withTitle: "Show logs")
        if alert.runModal() == .alertSecondButtonReturn { showLogs() }
        // A failed launch has nothing to keep alive for; quitting also stops
        // the server if it is half-up.
        NSApp.terminate(nil)
    }
}

// MARK: - Entry point

let application = NSApplication.shared
let launcher = Launcher()
application.delegate = launcher
application.setActivationPolicy(.regular)
application.run()
