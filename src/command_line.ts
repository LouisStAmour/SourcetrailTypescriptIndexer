import {
  CommandLineParser,
  CommandLineFlagParameter
} from "@microsoft/ts-command-line";
import { IndexFileAction, IndexProjectAction } from "./actions";
import { Indexing } from "./indexing_logic";

export class IndexerCommandLine extends CommandLineParser {
  private _verbose: CommandLineFlagParameter;

  public constructor() {
    super({
      toolFilename: "index",
      toolDescription:
        "Typescript Indexer for Sourcetrail using the TypeScript compiler and node bindings contributed to SourcetrailDB."
    });

    this.addAction(new IndexFileAction());
    this.addAction(new IndexProjectAction());
  }

  protected onDefineParameters(): void {
    this._verbose = this.defineFlagParameter({
      parameterLongName: "--verbose",
      parameterShortName: "-v",
      description: "Show extra logging detail"
    });
  }

  protected onExecute(): Promise<void> {
    Indexing.verbose = this._verbose?.value ?? false;
    return super.onExecute();
  }
}
