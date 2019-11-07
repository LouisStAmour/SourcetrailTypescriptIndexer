import {
  CommandLineAction,
  CommandLineFlagParameter,
  CommandLineStringParameter
} from "@microsoft/ts-command-line";

export class IndexAction extends CommandLineAction {
  private _databaseFilePath: CommandLineStringParameter;
  private _sourceFilePath: CommandLineStringParameter;
  private _clear: CommandLineFlagParameter;
  private _verbose: CommandLineFlagParameter;

  public constructor() {
    super({
      actionName: "index-file",
      summary: "Index a TypeScript source file",
      documentation:
        "Index a TypeScript source file and store the indexed data to a Sourcetrail database file."
    });
  }

  protected async onExecute(): Promise<void> {
    return console.log("Call indexing command work here!");
  }

  protected onDefineParameters(): void {
    this._databaseFilePath = this.defineStringParameter({
      parameterLongName: "--database-file-path",
      argumentName: "DATABASE_FILE_PATH",
      description: "path to the generated Sourcetrail database file",
      required: true
    });
    this._sourceFilePath = this.defineStringParameter({
      parameterLongName: "--source-file-path",
      argumentName: "SOURCE_FILE_PATH",
      description: "path to the source file to index",
      required: true
    });
    this._clear = this.defineFlagParameter({
      parameterLongName: "--clear",
      description: "clear the database before indexing",
      required: false
    });
  }
}
