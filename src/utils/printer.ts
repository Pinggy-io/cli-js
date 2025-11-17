import { loadChalk, loadOra } from "./esmOnlyPackageLoader.js";
import ora, { Ora } from "ora";

interface CLIErrorDefinition {
  match: (err: unknown) => boolean;
  message: (err: unknown) => string;
}

class CLIPrinter {
  private static spinner: Ora | null = null;
  private static chalk: typeof import("chalk")["default"] | null = null;
  private static ora: typeof import("ora")["default"] | null = null;

  static async ensureDeps() {
    if (!this.chalk) this.chalk = await loadChalk();
    if (!this.ora) this.ora = await loadOra();
  }
  
  private static isCLIError(err: unknown): err is Error & { code?: string; option?: string; value?: string } {
    return err instanceof Error;
  }
  private static errorDefinitions: CLIErrorDefinition[] = [
    {
      match: (err) => this.isCLIError(err) && err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION",
      message: (err) => {
        const match = /Unknown option '(.+?)'/.exec((err as any).message);
        const option = match ? match[1] : '(unknown)';
        return `Unknown option '${option}'. Please check your command or use pinggy --h for guidance.`;
      },
    },
    {
      match: (err) => this.isCLIError(err) && err.code === "ERR_PARSE_ARGS_MISSING_OPTION_VALUE",
      message: (err) => `Missing required argument for option '${(err as any).option}'.`,
    },
    {
      match: (err) => this.isCLIError(err) && err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
      message: (err) => `Invalid argument'${(err as any).message}'.`,
    },
    {
      match: (err) => this.isCLIError(err) && err.code === "ENOENT",
      message: (err) => `File or directory not found: ${(err as any).message}`,
    },
    {
      match: () => true, // fallback
      message: (err) => (this.isCLIError(err) ? err.message : String(err)),
    },
  ];

  static print(message: string, ...args: any[]) {
    console.log(message, ...args);
  }

  static error(err: unknown) {
    const def = this.errorDefinitions.find((d) => d.match(err))!;
    const msg = def.message(err);
    console.error(this.chalk!.redBright("✖ Error:"), this.chalk!.red(msg));
    process.exit(1);
  }

  static  warn(message: string) {
    console.warn(this.chalk!.yellowBright("⚠ Warning:"), this.chalk!.yellow(message));
  }

  static success(message: string) {
    console.log(this.chalk!.greenBright(" ✔ Success:"), this.chalk!.green(message));
  }

  static async info(message: string) {
    console.log(this.chalk!.blue(message));
  }

  static async startSpinner(message: string) {
    this.spinner = this.ora!({ text: message, color: "cyan" }).start();
  }

  static stopSpinnerSuccess(message: string) {
    this.spinner?.succeed(message);
    this.spinner = null;
  }

  static stopSpinnerFail(message: string) {
    this.spinner?.fail(message);
    this.spinner = null;
  }
}

export default CLIPrinter;
