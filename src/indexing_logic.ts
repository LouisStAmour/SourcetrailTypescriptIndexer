import * as ts from "typescript";
import {
  WriterType,
  Writer,
  SourceRange,
  NameHierarchy,
  NameElement,
  DefinitionKind,
  ReferenceKind,
  SymbolKind,
  FileId,
  LocalSymbolId,
  ReferenceId,
  SymbolId
} from "sourcetraildb";
import * as path from "path";
import { normalizePath, combinePaths } from "./util/path";

// The following is only partially written and heavily inspired by https://github.com/Microsoft/TypeScript/wiki/Using-the-Compiler-API#a-minimal-compiler
// and https://github.com/microsoft/TypeScript/blob/38652d4cd7edcdc84580a09dd5e9b304f62a2f2b/scripts/buildProtocol.ts

function isStringEnum(declaration: ts.EnumDeclaration) {
  return (
    declaration.members.length &&
    declaration.members.every(
      m => !!m.initializer && m.initializer.kind === ts.SyntaxKind.StringLiteral
    )
  );
}

const diagHost: ts.FormatDiagnosticsHost = {
  getCanonicalFileName(f) {
    return f;
  },
  getCurrentDirectory() {
    return ".";
  },
  getNewLine() {
    return "\r\n";
  }
};

/**
 * Report error and exit
 */
function reportUnrecoverableDiagnostic(diagnostic: ts.Diagnostic) {
  console.error(ts.formatDiagnostic(diagnostic, diagHost));
  ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
}

/** Parses config file using System interface */
function parseConfigFile(
  configFileName: string,
  optionsToExtend: ts.CompilerOptions = {},
  system: ts.System = ts.sys
) {
  const host: ts.ParseConfigFileHost = <any>system;
  host.onUnRecoverableConfigFileDiagnostic = reportUnrecoverableDiagnostic;
  const result = ts.getParsedCommandLineOfConfigFile(
    configFileName,
    optionsToExtend,
    host
  );
  host.onUnRecoverableConfigFileDiagnostic = undefined!; // TODO: GH#18217
  return result;
}

export class Indexing {
  private sdbWriter: WriterType;
  private fileIds = new Map<string, FileId>();
  private program: ts.Program;
  private diagnostics: readonly ts.Diagnostic[];
  public static verbose: boolean;

  private constructor(
    private databaseFilePath: string,
    config: ts.ParsedCommandLine
  ) {
    const { fileNames, options, projectReferences } = config;
    const host = ts.createCompilerHost(options);
    const programOptions: ts.CreateProgramOptions = {
      rootNames: fileNames,
      options,
      projectReferences,
      host,
      configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(config)
    };
    this.program = ts.createProgram(programOptions);
    this.diagnostics = ts.getPreEmitDiagnostics(this.program);
    this.sdbWriter = new Writer();
  }

  private getFileId(file: ts.SourceFile): FileId {
    let fileId = this.fileIds.get(file.fileName);
    if (fileId !== undefined) {
      return fileId;
    }
    // otherwise, we haven't indexed this file yet...
    fileId = this.sdbWriter.recordFile(file.fileName);
    if (fileId === 0) {
      new Error(this.sdbWriter.getLastError());
    }
    const result = this.sdbWriter.recordFileLanguage(fileId, "typescript");
    if (!result) {
      new Error(this.sdbWriter.getLastError());
    }
    this.fileIds.set(file.fileName, fileId);
    return fileId;
  }

  private addSourceFiles() {
    this.program
      .getSourceFiles()
      .forEach(sourceFile => this.getFileId(sourceFile));
  }

  private addDiagnostics() {
    this.diagnostics.forEach(diagnostic => {
      const message = ts.flattenDiagnosticMessageText(
        diagnostic.messageText,
        "\n"
      );
      if (!diagnostic.file) {
        console.log(message);
        return;
      }
      const start = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start!
      );
      const end = diagnostic.file.getLineAndCharacterOfPosition(
        diagnostic.start! + diagnostic.length!
      );
      const sourceRange = new SourceRange(
        this.getFileId(diagnostic.file),
        start.line + 1,
        start.character + 1,
        end.line + 1,
        end.character + 1
      );
      const result = this.sdbWriter.recordError(message, false, sourceRange);
      if (!result) {
        new Error(this.sdbWriter.getLastError());
      }
    });
  }

  // TODO: Rename and rewrite these to traverse and map to Sourcetrail symbols, etc.
  // Use https://github.com/CoatiSoftware/SourcetrailPythonIndexer/blob/master/indexer.py as an example
  private visitTypeNodes(node: ts.Node) {
    /* if (node.parent) {
      switch (node.parent.kind) {
        case ts.SyntaxKind.IndexSignature:
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.MethodSignature:
        case ts.SyntaxKind.Parameter:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.PropertySignature:
        case ts.SyntaxKind.VariableDeclaration:
          if (
            (<
              | ts.IndexSignatureDeclaration
              | ts.MethodDeclaration
              | ts.MethodSignature
              | ts.ParameterDeclaration
              | ts.PropertyDeclaration
              | ts.PropertySignature
              | ts.VariableDeclaration
            >node.parent).type === node
          ) {
            this.processTypeOfNode(node);
          }
          break;
        case ts.SyntaxKind.InterfaceDeclaration:
          const heritageClauses = (<ts.InterfaceDeclaration>node.parent)
            .heritageClauses;
          if (heritageClauses) {
            if (heritageClauses[0].token !== ts.SyntaxKind.ExtendsKeyword) {
              throw new Error(
                `Unexpected kind of heritage clause: ${
                  ts.SyntaxKind[heritageClauses[0].kind]
                }`
              );
            }
            for (const type of heritageClauses[0].types) {
              this.processTypeOfNode(type);
            }
          }
          break;
      }
    }*/
    if (node.kind === ts.SyntaxKind.Identifier) {
      debugger;
    }

    ts.forEachChild(node, n => this.visitTypeNodes(n));
  }
  /*
  private processTypeOfNode(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.UnionType) {
      for (const t of (<ts.UnionTypeNode>node).types) {
        this.processTypeOfNode(t);
      }
    } else {
      const type = this.program.getTypeChecker().getTypeAtLocation(node);
      if (type && !(type.flags & ts.TypeFlags.TypeParameter)) {
        this.processType(type);
      }
    }
  }

  private processType(type: ts.Type): void {
    // if (this.visitedTypes.indexOf(type) >= 0) {
    //   return;
    // }
    // this.visitedTypes.push(type);
    const s = type.aliasSymbol || type.getSymbol();
    if (!s) {
      return;
    }
    if (s.name === "Array" || s.name === "ReadOnlyArray") {
      // we should process type argument instead
      return this.processType((<any>type).typeArguments[0]);
    } else {
      const declarations = s.getDeclarations();
      if (declarations) {
        for (const decl of declarations) {
          const sourceFile = decl.getSourceFile();
          if (
            sourceFile.fileName === "this.protocolFile" ||
            /lib(\..+)?\.d.ts/.test(path.basename(sourceFile.fileName))
          ) {
            return;
          }
          if (
            decl.kind === ts.SyntaxKind.EnumDeclaration &&
            !isStringEnum(decl as ts.EnumDeclaration)
          ) {
            // this.removedTypes.push(type);
            return;
          } else {
            // splice declaration in final d.ts file
            // const text = decl.getFullText();
            // this.text += `${text}\n`;
            // recursively pull all dependencies into result dts file

            this.visitTypeNodes(decl);
          }
        }
      }
    }
  }*/

  private open(block: () => void) {
    const result = this.sdbWriter.open(this.databaseFilePath);
    if (!result) {
      new Error(this.sdbWriter.getLastError());
    }
    try {
      block();
    } finally {
      const result = this.sdbWriter.close();
      if (!result) {
        new Error(this.sdbWriter.getLastError());
      }
    }
  }

  static IndexFile(
    databaseFilePath: string,
    filename: string,
    clear: boolean
  ): void {
    Indexing.PerformIndexing(
      databaseFilePath,
      {
        fileNames: [filename],
        options: {},
        errors: []
      },
      clear
    );
  }

  static IndexProject(
    databaseFilePath: string,
    projectPath: string | undefined,
    clear: boolean
  ): void {
    let configFileName: string | undefined;
    if (projectPath === undefined) {
      const currentDirectory = ts.sys.getCurrentDirectory();
      const searchPath = normalizePath(currentDirectory);
      configFileName = ts.findConfigFile(searchPath, ts.sys.fileExists);
      if (configFileName === undefined) {
        console.error(
          "Cannot find a tsconfig.json file at the specified directory: ",
          currentDirectory
        );
        return ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
      }
    } else {
      const fileOrDirectory = normalizePath(projectPath);
      if (
        !fileOrDirectory /* "." */ ||
        ts.sys.directoryExists(fileOrDirectory)
      ) {
        configFileName = combinePaths(fileOrDirectory, "tsconfig.json");
        if (!ts.sys.fileExists(configFileName)) {
          console.error(
            "Cannot find a tsconfig.json file at the specified directory: ",
            projectPath
          );
          return ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
        }
      } else {
        configFileName = fileOrDirectory;
        if (!ts.sys.fileExists(configFileName)) {
          if (!ts.sys.fileExists(configFileName)) {
            console.error("The specified path does not exist: ", projectPath);
            return ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
          }
        }
      }
    }
    const config = parseConfigFile(configFileName);
    if (config.errors.length > 0) {
      config.errors.forEach(diagnostic =>
        console.error(ts.formatDiagnostic(diagnostic, diagHost))
      );
      ts.sys.exit(ts.ExitStatus.DiagnosticsPresent_OutputsSkipped);
    }
    Indexing.PerformIndexing(databaseFilePath, config, clear);
  }

  static PerformIndexing(
    databaseFilePath: string,
    config: ts.ParsedCommandLine,
    clear: boolean
  ): void {
    const indexer = new Indexing(databaseFilePath, config);
    indexer.open(() => {
      if (clear) indexer.sdbWriter.clear();
      indexer.addSourceFiles();
      indexer.addDiagnostics();
      indexer.program
        .getSourceFiles()
        .forEach(sf => indexer.visitTypeNodes(sf));
    });
  }
}
