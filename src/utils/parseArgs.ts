import { parseArgs } from "util";
import { cliOptions } from "../cli/options";

export type OptionSpec = {
    type: 'string' | 'boolean';
    multiple?: boolean;
    short?: string;
    description?: string;
    hidden?: boolean;
};

export type CliOptions = typeof cliOptions;

export type ParsedValues<T extends Record<string, OptionSpec>> = {
    [K in keyof T]:
    T[K]['type'] extends 'string'
    ? (T[K]['multiple'] extends true ? string[] : string | undefined)
    : (T[K]['type'] extends 'boolean' ? boolean | undefined : never);
};

export function parseCliArgs<T extends Record<string, OptionSpec>>(options: T) {
    return parseArgs({
        options,
        allowPositionals: true,
    }) as unknown as {
        values: ParsedValues<T>;
        positionals: string[];
    };
}
