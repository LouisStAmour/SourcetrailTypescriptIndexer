import {
  CommandLineParser,
  CommandLineFlagParameter
} from "@microsoft/ts-command-line";
import { IndexAction } from "./IndexAction";

export class IndexerCommandLine extends CommandLineParser {
  private _verbose: CommandLineFlagParameter;

  public constructor() {
    super({
      toolFilename: "index",
      toolDescription:
        "Typescript Indexer for Sourcetrail using the TypeScript compiler and node bindings contributed to SourcetrailDB."
    });

    this.addAction(new IndexAction());
  }

  protected onDefineParameters(): void {
    this._verbose = this.defineFlagParameter({
      parameterLongName: "--verbose",
      parameterShortName: "-v",
      description: "Show extra logging detail"
    });
  }

  protected onExecute(): Promise<void> {
    // override
    //BusinessLogic.configureLogger(this._verbose.value);
    return super.onExecute();
  }
}
