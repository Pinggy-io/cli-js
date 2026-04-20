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

// Matches -R or -L followed by at least one character 
// Accepts values like -R0, -R0:127.0.0.1:8000, -Rtcp//a.example.com/18463:0:localhost:30814
function isAttachedReverseOrLocalFlag(arg: string): boolean {
  return /^-[RL].+/.test(arg);
}


function shouldMergeReverseOrLocalFragment(
  current: string,
  next: string,
): boolean {
  if (next.startsWith("-")) {
    return false;
  }

  // PowerShell may split domains at dots in forms like -Rtcp//a.test... into
  // -Rtcp//a and .test..., so keep joining dot-prefixed fragments.
  if (next.startsWith(".")) {
    return true;
  }

  const body = current.slice(2);
  
  // A trailing colon indicates a shell split right after ':'
  if (body.endsWith(":")) {
    return true;
  }

  // Protocol forwarding must eventually contain ':' separators after host info.
  // If schema exists but no ':' yet, this token is incomplete.
  if (body.includes("//") && !body.includes(":")) {
    return true;
  }

  return false;
}

// Pre-processes command-line arguments to fix Windows-cmd-specific issues(arguments get split by ':')
export function preprocessWindowsArgs(args: string[]): string[] {
  // if the os is not windows skip everything and return args. Problem is currently noticed only in windows
  if (os.platform() !== "win32") {
    return args;
  };

  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // CASE 1: inline flags with attached value: -R..., -L...
    if (isAttachedReverseOrLocalFlag(arg)) {
      let merged = arg;
      while (
        i + 1 < args.length &&
        shouldMergeReverseOrLocalFragment(merged, args[i + 1])
      ) {
        // Merge the next fragment into the current one
        merged += args[i + 1];
        i++;
      }
      out.push(merged);
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
