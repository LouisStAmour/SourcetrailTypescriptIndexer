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
  private sdbWriter: WriterType;
  private fileIds = new Map<string, FileId>();
  private program: ts.Program;
  private host: ts.CompilerHost;
  private diagnostics: readonly ts.Diagnostic[];
  public static verbose: boolean;

  private constructor(
    private databaseFilePath: string,
    config: ts.ParsedCommandLine
  ) {
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

  private recordPackage(name: NameHierarchy) {
    const symbolId = this.sdbWriter.recordSymbol(name);
    if (symbolId === 0) {
      new Error(this.sdbWriter.getLastError());
    }
    if (
      !this.sdbWriter.recordSymbolDefinitionKind(
        symbolId,
        DefinitionKind.EXPLICIT
      )
    ) {
      new Error(this.sdbWriter.getLastError());
    }
    if (!this.sdbWriter.recordSymbolKind(symbolId, SymbolKind.PACKAGE)) {
      new Error(this.sdbWriter.getLastError());
    }
    return symbolId;
  }

  private recordModule(
    name: NameHierarchy,
    sf: ts.SourceFile,
    sfFileId: FileId
  ) {
    const symbolId = this.sdbWriter.recordSymbol(name);
    if (symbolId === 0) {
      new Error(this.sdbWriter.getLastError());
    }
    if (
      !this.sdbWriter.recordSymbolDefinitionKind(
        symbolId,
        DefinitionKind.EXPLICIT
      )
    ) {
      new Error(this.sdbWriter.getLastError());
    }
    if (!this.sdbWriter.recordSymbolKind(symbolId, SymbolKind.MODULE)) {
      new Error(this.sdbWriter.getLastError());
    }
    if (
      !this.sdbWriter.recordSymbolScopeLocation(
        symbolId,
        this.nodeToSourceRange(sf, sfFileId)
      )
    ) {
      new Error(this.sdbWriter.getLastError());
    }
    return symbolId;
  }

  private nodeToSourceRange(node: ts.Node, fileId: FileId) {
    const start = node
      .getSourceFile()
      .getLineAndCharacterOfPosition(node.getStart());
    const end = node
      .getSourceFile()
      .getLineAndCharacterOfPosition(node.getEnd());
    return this.toSourceRange(fileId, start, end);
  }

  private toSourceRange(
    fileId: number,
    start: ts.LineAndCharacter,
    end: ts.LineAndCharacter
  ) {
    return new SourceRange(
      fileId,
      start.line + 1,
      start.character,
      end.line + 1,
      end.character + 1
    );
  }

  private libReferenceToSourceRange(
    ref: ts.FileReference,
    sf: ts.SourceFile,
    fileId: FileId
  ) {
    const start = sf.getLineAndCharacterOfPosition(ref.pos);
    const end = sf.getLineAndCharacterOfPosition(ref.end);
    return this.toSourceRange(fileId, start, end);
  }

  private addCurrentFile(sf: ts.SourceFile) {
    const fileId = this.getFileId(sf);
    //const sfSymbolId = this.sourceFileToModuleSymbolId(sf, fileId);
    sf.libReferenceDirectives.forEach(ref => {
      const refSourceFile = (this.program as any).getLibFileFromReference(ref);
      const refFileId = this.getFileId(refSourceFile);
      const refFileSymbolId = this.sourceFileToModuleSymbolId(
        refSourceFile,
        fileId
      );
      const refSymbolId = this.sdbWriter.recordSymbol(
        new NameHierarchy("", [
          new NameElement(`<reference lib="${ref.fileName}" />`)
        ])
      );
      if (refSymbolId === 0) {
        new Error(this.sdbWriter.getLastError());
      }
      let success = this.sdbWriter.recordSymbolDefinitionKind(
        refSymbolId,
        DefinitionKind.EXPLICIT
      );
      if (!success) {
        new Error(this.sdbWriter.getLastError());
      }
      success = this.sdbWriter.recordSymbolKind(refSymbolId, SymbolKind.MACRO);
      if (!success) {
        new Error(this.sdbWriter.getLastError());
      }
      success = this.sdbWriter.recordSymbolLocation(
        refSymbolId,
        this.libReferenceToSourceRange(ref, sf, fileId)
      );
      if (!success) {
        new Error(this.sdbWriter.getLastError());
      }
      const referenceId = this.sdbWriter.recordReference(
        refSymbolId,
        refFileSymbolId,
        ReferenceKind.INCLUDE
      );
      if (referenceId === 0) {
        new Error(this.sdbWriter.getLastError());
      }
      success = this.sdbWriter.recordReferenceLocation(
        referenceId,
        this.libReferenceToSourceRange(ref, sf, fileId)
      );
      if (!success) {
        new Error(this.sdbWriter.getLastError());
      }
    });
  }

  private sourceFileToModuleSymbolId(sf: ts.SourceFile, sfFileId: FileId) {
    const filenameParts = path
      .relative(this.program.getCurrentDirectory(), sf.fileName)
      .split(path.sep);
    const name = new NameHierarchy(
      "/",
      filenameParts.map(p => new NameElement(p))
    );
    const symbolId = this.recordModule(name, sf, sfFileId);
    if (symbolId === 0) {
      new Error(this.sdbWriter.getLastError());
    }
    for (let i = 0; i < filenameParts.length; i++) {
      if (filenameParts[i] === "node_modules") {
        const packageSymbolId = this.recordPackage(
          new NameHierarchy(
            "/",
            filenameParts.slice(i, i + 2).map(p => new NameElement(p))
          )
        );
        if (packageSymbolId === 0) {
          new Error(this.sdbWriter.getLastError());
        }
        const refId = this.sdbWriter.recordReference(
          packageSymbolId,
          symbolId,
          ReferenceKind.INCLUDE
        );
        if (refId === 0) {
          new Error(this.sdbWriter.getLastError());
        }
      }
    }
    return symbolId;
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
      if (!indexer.sdbWriter.beginTransaction()) {
        new Error(indexer.sdbWriter.getLastError());
      }
      if (clear) {
        if (!indexer.sdbWriter.clear()) {
          new Error(indexer.sdbWriter.getLastError());
        }
      }
      if (!indexer.sdbWriter.commitTransaction()) {
        new Error(indexer.sdbWriter.getLastError());
      }
      if (!indexer.sdbWriter.optimizeDatabaseMemory()) {
        new Error(indexer.sdbWriter.getLastError());
      }
      if (!indexer.sdbWriter.beginTransaction()) {
        new Error(indexer.sdbWriter.getLastError());
      }
      indexer.addDiagnostics();
      indexer.program.getSourceFiles().forEach(sf => {
        indexer.addCurrentFile(sf);
        //indexer.visitTypeNodes(sf);
      });
      if (!indexer.sdbWriter.commitTransaction()) {
        new Error(indexer.sdbWriter.getLastError());
      }
      if (!indexer.sdbWriter.optimizeDatabaseMemory()) {
        new Error(indexer.sdbWriter.getLastError());
      }
    });
  }
}
