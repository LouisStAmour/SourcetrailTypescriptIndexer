import {
  CommandLineAction,
  CommandLineFlagParameter,
  CommandLineStringParameter
} from "@microsoft/ts-command-line";
import { Indexing } from "./indexing_logic";

export class IndexFileAction extends CommandLineAction {
  private _databaseFilePath: CommandLineStringParameter;
  private _sourceFilePath: CommandLineStringParameter;
  private _clear: CommandLineFlagParameter;
  private _verbose: CommandLineFlagParameter;

  public constructor() {
    super({
      actionName: "file",
      summary: "Index a TypeScript source file",
      documentation:
        "Index a TypeScript source file and store the indexed data to a Sourcetrail database file."
    });
  }

  protected async onExecute(): Promise<void> {
    Indexing.IndexFile(
      this._databaseFilePath.value,
      this._sourceFilePath.value,
      this._verbose.value
    );
  }

  protected onDefineParameters(): void {
    this._databaseFilePath = this.defineStringParameter({
      parameterLongName: "--database-file-path",
      argumentName: "DATABASE_FILE_PATH",
      parameterShortName: "-d",
      description: "path to the generated Sourcetrail database file",
      defaultValue: "database.srctrldb"
    });
    this._sourceFilePath = this.defineStringParameter({
      parameterLongName: "--source-file-path",
      argumentName: "SOURCE_FILE_PATH",
      parameterShortName: "-f",
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

export class IndexProjectAction extends CommandLineAction {
  private _databaseFilePath: CommandLineStringParameter;
  private _sourceProjectPath: CommandLineStringParameter;
  private _clear: CommandLineFlagParameter;
  private _verbose: CommandLineFlagParameter;

  public constructor() {
    super({
      actionName: "project",
      summary: "Index a TypeScript project",
      documentation:
        "Index a TypeScript project and store the indexed data to a Sourcetrail database file."
    });
  }

  protected async onExecute(): Promise<void> {
    Indexing.IndexProject(
      this._databaseFilePath.value,
      this._sourceProjectPath.value,
      this._verbose.value
    );
  }

  protected onDefineParameters(): void {
    this._databaseFilePath = this.defineStringParameter({
      parameterLongName: "--database-file-path",
      argumentName: "DATABASE_FILE_PATH",
      parameterShortName: "-d",
      description: "path to the generated Sourcetrail database file",
      defaultValue: "database.srctrldb"
    });
    this._sourceProjectPath = this.defineStringParameter({
      parameterLongName: "--project-path",
      parameterShortName: "-p",
      argumentName: "SOURCE_PROJECT_PATH",
      description:
        "path of a directory containing a tsconfig.json file, or a path to a valid tsconfig JSON file",
      required: false
    });
    this._clear = this.defineFlagParameter({
      parameterLongName: "--clear",
      description: "clear the database before indexing",
      required: false
    });
  }
}
