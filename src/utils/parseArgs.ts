import { parseArgs } from "util";

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

export function parseCliArgs<T extends Record<string, OptionSpec>>(options: T) {
    const parsed = parseArgs({
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
