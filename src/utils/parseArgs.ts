import { parseArgs } from "util";
import * as os from "os";

export type OptionSpec = {
    type: 'string' | 'boolean';
    multiple?: boolean;
    short?: string;
    description?: string;
    hidden?: boolean;
};


export type ParsedValues<T extends Record<string, OptionSpec>> = {
    [K in keyof T]:
    T[K]['type'] extends 'string'
    ? (T[K]['multiple'] extends true ? string[] : string | undefined)
    : (T[K]['type'] extends 'boolean' ? boolean | undefined : never);
};

// Check if arg starts with -R, -Ra, -Rhost, -Rh..., etc.
function isInlineColonFlag(arg: string): boolean {
    return /^-([RL])[A-Za-z0-9._-]*:?$/.test(arg);
}


// Pre-processes command-line arguments to fix Windows-cmd-specific issues(arguments get split by ':')
export function preprocessWindowsArgs(args: string[]): string[] {
    // if the os is not windows skip everything and return args. Problem is currently noticed only in windows
    if (os.platform() !== "win32") return args;

    const out: string[] = [];
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        // CASE 1: inline flags: -Rhost:  -Ra.test.com:
        if (isInlineColonFlag(arg)) {
            // If next arg exists and is NOT a flag, merge it
            if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                let merged = arg + args[i + 1];
                i += 2;
                out.push(merged);
                continue;
            }
            out.push(arg);
            i++;
            continue;
        }
        // Default: push arg
        out.push(arg);
        i++;
    }

    return out;
}

export function parseCliArgs<T extends Record<string, OptionSpec>>(options: T) {
    const rawArgs = process.argv.slice(2);

    // Pre-process arguments for Windows compatibility
    const processedArgs = preprocessWindowsArgs(rawArgs);
    const parsed = parseArgs({
        args: processedArgs,
        options,
        allowPositionals: true,
    }) as unknown as {
        values: ParsedValues<T>;
        positionals: string[];
    };

    const hasAnyArgs =
        parsed.positionals.length > 0 ||
        Object.values(parsed.values).some(v => v !== undefined && v !== false);

    return {
        ...parsed,
        hasAnyArgs,
    }

}
