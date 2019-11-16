import * as ts from "typescript";
import SourcetrailDB, {
  FileBuilder,
  ReferenceKind,
  SymbolKind
} from "sourcetraildb/dist/builder";

import * as path from "path";
import * as tspath from "./util/path";
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
  private fileIds = new Map<string, FileBuilder>();
  private program: ts.Program;
  private host: ts.CompilerHost;
  private diagnostics: readonly ts.Diagnostic[];
  public static verbose: boolean;

  private constructor(config: ts.ParsedCommandLine) {
    const { fileNames, options, projectReferences } = config;
    this.host = ts.createCompilerHost(options);
    const programOptions: ts.CreateProgramOptions = {
      rootNames: fileNames,
      options,
      projectReferences,
      host: this.host,
      configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(config)
    };
    this.program = ts.createProgram(programOptions);
    this.diagnostics = ts.getPreEmitDiagnostics(this.program);
  }

  private getFile(writer: SourcetrailDB, file: ts.SourceFile): FileBuilder {
    let fileId = this.fileIds.get(file.fileName);
    if (fileId !== undefined) {
      return fileId;
    }
    // otherwise, we haven't indexed this file yet...
    fileId = writer.createFile(file.fileName).asLanguage("typescript");
    this.fileIds.set(file.fileName, fileId);
    return fileId;
  }

  private addDiagnostics(writer: SourcetrailDB) {
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
      const sourceRange = this.getFile(writer, diagnostic.file).at(
        start.line + 1,
        start.character + 1,
        end.line + 1,
        end.character + 1
      );
      writer.recordError(message, sourceRange);
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
    if (node.kind === ts.SyntaxKind.Identifier && node.getText() === "Utils") {
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

  private nodeToSourceRange(node: ts.Node, file: FileBuilder) {
    const start = node
      .getSourceFile()
      .getLineAndCharacterOfPosition(node.getStart());
    const end = node
      .getSourceFile()
      .getLineAndCharacterOfPosition(node.getEnd());
    return this.toSourceRange(file, start, end);
  }

  private toSourceRange(
    file: FileBuilder,
    start: ts.LineAndCharacter,
    end: ts.LineAndCharacter
  ) {
    return file.at(
      start.line + 1,
      start.character,
      end.line + 1,
      end.character + 1
    );
  }

  private libReferenceToSourceRange(
    ref: ts.FileReference,
    sf: ts.SourceFile,
    file: FileBuilder
  ) {
    const start = sf.getLineAndCharacterOfPosition(ref.pos);
    const end = sf.getLineAndCharacterOfPosition(ref.end);
    return this.toSourceRange(file, start, end);
  }

  private addCurrentFile(writer: SourcetrailDB, sf: ts.SourceFile) {
    const file = this.getFile(writer, sf);
    //const sfSymbolId = this.sourceFileToModuleSymbolId(sf, fileId);
    sf.libReferenceDirectives.forEach(ref => {
      const refSourceFile: ts.SourceFile = (this
        .program as any).getLibFileFromReference(ref);
      const refFile = this.getFile(writer, refSourceFile);
      const refFileSymbolId = this.sourceFileToModuleSymbol(
        writer,
        refSourceFile,
        file
      );
      const refSymbol = writer
        .createSymbol(`<reference lib="${ref.fileName}" />`)
        .explicitly()
        .ofType(SymbolKind.MACRO)
        .atLocation(this.libReferenceToSourceRange(ref, sf, file))
        .isReferencedBy(refFileSymbolId, ReferenceKind.INCLUDE)
        .atLocation(this.libReferenceToSourceRange(ref, sf, file));
    });
  }

  private sourceFileToModuleSymbol(
    writer: SourcetrailDB,
    sf: ts.SourceFile,
    sfFile: FileBuilder
  ) {
    const filenameParts = path
      .relative(this.program.getCurrentDirectory(), sf.fileName)
      .split(path.sep);
    const symbol = writer
      .createSymbol("/", filenameParts)
      .explicitly()
      .ofType(SymbolKind.MODULE)
      .withScope(this.nodeToSourceRange(sf, sfFile));
    for (let i = 0; i < filenameParts.length; i++) {
      if (filenameParts[i] === "node_modules") {
        writer
          .createSymbol("/", filenameParts.slice(i, i + 2))
          .explicitly()
          .ofType(SymbolKind.PACKAGE)
          .withScope(this.nodeToSourceRange(sf, sfFile))
          .isReferencedBy(symbol, ReferenceKind.INCLUDE);
      }
    }
    return symbol;
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
    const indexer = new Indexing(config);
    SourcetrailDB.open(
      databaseFilePath,
      writer => {
        indexer.addDiagnostics(writer);
        indexer.program.getSourceFiles().forEach(sf => {
          indexer.addCurrentFile(writer, sf);
          //indexer.visitTypeNodes(sf);
        });
      },
      clear
    );
  }
}
