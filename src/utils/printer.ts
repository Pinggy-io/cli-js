import pico from "picocolors";
import { startSpinner, stopSpinnerSuccess as stopSpinnerSuccessCustom, stopSpinnerFail as stopSpinnerFailCustom } from "../tui/spinner/spinner.js";

interface CLIErrorDefinition {
  match: (err: unknown) => boolean;
  message: (err: unknown) => string;
}

class CLIPrinter {

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
    console.error(pico.red(pico.bold("✖ Error:")), pico.red(msg));
    process.exit(1);
  }

  static warn(message: string) {
    console.warn(pico.yellow(pico.bold("⚠ Warning:")), pico.yellow(message));
  }

  static warnTxt(message: string) {
    console.warn(pico.yellow(pico.bold("⚠ Warning:")), pico.yellow(message));
  }

  static success(message: string) {
    console.log(pico.green(pico.bold(" ✔ Success:")), pico.green(message));
  }

  static async info(message: string) {
    console.log(pico.blue(message));
  }

  static startSpinner(message: string) {
    startSpinner('dots', message);
  }

  static stopSpinnerSuccess(message: string) {
    stopSpinnerSuccessCustom(message);
  }

  static stopSpinnerFail(message: string) {
    stopSpinnerFailCustom(message);
  }
}

export default CLIPrinter;
