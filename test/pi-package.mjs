// Helpers for tests that load index.ts, which imports the installed Pi package.
// Such tests are opt-in (PI_TEST_PI_ROOT): loading the package can take 20 s.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The installed Pi package root: PI_TEST_PI_ROOT when it names the package, otherwise the
 * package that `pi` on PATH belongs to. A managed install puts a launcher script on PATH, with
 * the package under <launcher dir>/../install/releases/<current-version>. Undefined when none is found.
 */
export function installedPiRoot() {
	const isPackage = (dir) => existsSync(join(dir, "package.json")) && existsSync(join(dir, "dist"));
	if (process.env.PI_TEST_PI_ROOT && isPackage(process.env.PI_TEST_PI_ROOT)) return process.env.PI_TEST_PI_ROOT;
	try {
		const launcher = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
		for (let dir = dirname(launcher); dir !== dirname(dir); dir = dirname(dir)) if (isPackage(dir)) return dir;
		const install = join(dirname(launcher), "..", "install");
		const managed = join(install, "releases", readFileSync(join(install, "current-version"), "utf8").trim(), "node_modules", "@earendil-works", "pi-coding-agent");
		return isPackage(managed) ? managed : undefined;
	} catch {
		return undefined;
	}
}

/** The Pi package for an opt-in test, and the reason to skip the test when it is not available. */
export function piPackageForTests() {
	const piRoot = process.env.PI_TEST_PI_ROOT ? installedPiRoot() : undefined;
	const skip = !process.env.PI_TEST_PI_ROOT
		? "Set PI_TEST_PI_ROOT to load index.ts with the installed Pi package"
		: !piRoot && "Could not find the installed Pi package";
	return { piRoot, skip };
}

/** Resolve index.ts's Pi imports from the installed package, without an extension node_modules. */
export function resolvePiImportsFrom(piRoot) {
	registerHooks({
		resolve(specifier, context, next) {
			if (["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].includes(specifier)) {
				return next(specifier, { ...context, parentURL: pathToFileURL(join(piRoot, "package.json")).href });
			}
			return next(specifier, context);
		},
	});
}
