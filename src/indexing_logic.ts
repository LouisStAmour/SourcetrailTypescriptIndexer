import * as ts from "typescript";
import SourcetrailDB, {
  FileBuilder,
  ReferenceKind,
  SymbolKind
} from "sourcetraildb/dist/builder";

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

function toSourceRange(
  file: FileBuilder,
  start: ts.LineAndCharacter,
  end: ts.LineAndCharacter
) {
  return file.at(
    start.line + 1,
    start.character + 1,
    end.line + 1,
    end.character
  );
}

function nodeToSourceRange(node: ts.Node, file: FileBuilder) {
  const start = node
    .getSourceFile()
    .getLineAndCharacterOfPosition(node.getStart());
  const end = node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd());
  return toSourceRange(file, start, end);
}

function libReferenceToSourceRange(
  ref: ts.FileReference,
  sf: ts.SourceFile,
  file: FileBuilder
) {
  const start = sf.getLineAndCharacterOfPosition(ref.pos);
  const end = sf.getLineAndCharacterOfPosition(ref.end);
  return toSourceRange(file, start, end);
}

function getLeadingCommentRangesOfNode(
  node: ts.Node,
  sourceFileOfNode: ts.SourceFile
) {
  return node.kind !== ts.SyntaxKind.JsxText
    ? ts.getLeadingCommentRanges(sourceFileOfNode.text, node.pos)
    : undefined;
}

const regionDelimiterRegExp = /^\s*\/\/\s*#(end)?region(?:\s+(.*))?(?:\r)?$/;
function isRegionDelimiter(lineText: string) {
  return regionDelimiterRegExp.exec(lineText);
}

function recordAtomicSourceRangesForMultilineComments(
  writer: SourcetrailDB,
  fileBuilder: FileBuilder,
  sourceFile: ts.SourceFile,
  n: ts.Node
): void {
  const comments = getLeadingCommentRangesOfNode(n, sourceFile);
  if (!comments) return;
  let firstSingleLineCommentStart = -1;
  let lastSingleLineCommentEnd = -1;
  let singleLineCommentCount = 0;
  const sourceText = sourceFile.getFullText();
  for (const { kind, pos, end } of comments) {
    switch (kind) {
      case ts.SyntaxKind.SingleLineCommentTrivia:
        // never fold region delimiters into single-line comment regions
        const commentText = sourceText.slice(pos, end);
        if (isRegionDelimiter(commentText)) {
          combineAndAddMultipleSingleLineComments();
          singleLineCommentCount = 0;
          break;
        }

        // For single line comments, combine consecutive ones (2 or more) into
        // a single span from the start of the first till the end of the last
        if (singleLineCommentCount === 0) {
          firstSingleLineCommentStart = pos;
        }
        lastSingleLineCommentEnd = end;
        singleLineCommentCount++;
        break;
      case ts.SyntaxKind.MultiLineCommentTrivia:
        combineAndAddMultipleSingleLineComments();
        const startLC = sourceFile.getLineAndCharacterOfPosition(pos);
        const endLC = sourceFile.getLineAndCharacterOfPosition(end);
        writer.recordAtomicSourceRange(
          toSourceRange(fileBuilder, startLC, endLC)
        );
        singleLineCommentCount = 0;
        break;
    }
  }
  combineAndAddMultipleSingleLineComments();

  function combineAndAddMultipleSingleLineComments(): void {
    // Only outline spans of two or more consecutive single line comments
    if (singleLineCommentCount > 1) {
      const startLC = sourceFile.getLineAndCharacterOfPosition(
        firstSingleLineCommentStart
      );
      const endLC = sourceFile.getLineAndCharacterOfPosition(
        lastSingleLineCommentEnd
      );
      writer.recordAtomicSourceRange(
        toSourceRange(fileBuilder, startLC, endLC)
      );
    }
  }
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

  private addOrGetFile(
    writer: SourcetrailDB,
    file: ts.SourceFile
  ): FileBuilder {
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
      const sourceRange = this.addOrGetFile(writer, diagnostic.file).at(
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
  private visitTypeNodes(
    writer: SourcetrailDB,
    file: FileBuilder,
    node: ts.Node
  ): void {
    const sf = node.getSourceFile();
    recordAtomicSourceRangesForMultilineComments(writer, file, sf, node);

    switch (node.kind) {
      case ts.SyntaxKind.Constructor:
        // Get parameter properties, and treat them as being on the *same* level as the constructor, not under it.
        const ctr = <ts.ConstructorDeclaration>node;
        //temp:debugger;
        //addNodeWithRecursiveChild(ctr, ctr.body);

        // Parameter properties are children of the class, not the constructor.
        for (const param of ctr.parameters) {
          if (ts.isParameterPropertyDeclaration(param, ctr)) {
            //temp:debugger;
            //addLeafNode(param);
          }
        }
        break;

      case ts.SyntaxKind.MethodDeclaration:
      case ts.SyntaxKind.GetAccessor:
      case ts.SyntaxKind.SetAccessor:
      case ts.SyntaxKind.MethodSignature:
        const n = node as
          | ts.MethodDeclaration
          | ts.GetAccessorDeclaration
          | ts.SetAccessorDeclaration
          | ts.MethodSignature;
        const names: string[] = [];
        for (
          let s: ts.Symbol = (n as any).symbol;
          s !== undefined;
          s = (s as any).parent as ts.Symbol
        ) {
          names.unshift(s.name);
        }
        writer
          .createSymbol(".", names)
          .explicitly()
          .ofType(SymbolKind.FIELD)
          .atLocation(nodeToSourceRange(n.name, file))
          .withSignature(nodeToSourceRange(n, file));
        // if (!ts.hasDynamicName(<ts.ClassElement | ts.TypeElement>node)) {
        //   addNodeWithRecursiveChild(
        //     node,
        //     (<ts.FunctionLikeDeclaration>node).body
        //   );
        // }
        break;

      case ts.SyntaxKind.PropertyDeclaration:
      case ts.SyntaxKind.PropertySignature:
        //temp:debugger;
        // if (!ts.hasDynamicName(<ts.ClassElement | ts.TypeElement>node)) {
        //   addLeafNode(node);
        // }
        break;

      case ts.SyntaxKind.ImportClause:
        const importClause = <ts.ImportClause>node;
        // Handle default import case e.g.:
        //    import d from "mod";
        if (importClause.name) {
          //temp:debugger;
          // addLeafNode(importClause.name);
        }

        // Handle named bindings in imports e.g.:
        //    import * as NS from "mod";
        //    import {a, b as B} from "mod";
        const { namedBindings } = importClause;
        if (namedBindings) {
          if (namedBindings.kind === ts.SyntaxKind.NamespaceImport) {
            //temp:debugger;
            // addLeafNode(namedBindings);
          } else {
            for (const element of namedBindings.elements) {
              //temp:debugger;
              // addLeafNode(element);
            }
          }
        }
        break;

      case ts.SyntaxKind.ShorthandPropertyAssignment:
        //temp:debugger;
        // addNodeWithRecursiveChild(
        //   node,
        //   (<ts.ShorthandPropertyAssignment>node).name
        // );
        break;
      case ts.SyntaxKind.SpreadAssignment:
        const { expression } = <ts.SpreadAssignment>node;
        //temp:debugger;
        // Use the expression as the name of the SpreadAssignment, otherwise show as <unknown>.
        // ts.isIdentifier(expression)
        //   ? addLeafNode(node, expression)
        //   : addLeafNode(node);
        break;
      case ts.SyntaxKind.BindingElement:
      case ts.SyntaxKind.PropertyAssignment:
      case ts.SyntaxKind.VariableDeclaration:
        const { name, initializer } = node as
          | ts.VariableDeclaration
          | ts.PropertyAssignment
          | ts.BindingElement;
        // if (ts.isBindingPattern(name)) {
        //   addChildrenRecursively(name);
        // } else if (
        //   initializer &&
        //   ts.isFunctionOrClassExpression(initializer)
        // ) {
        //   // Add a node for the VariableDeclaration, but not for the initializer.
        //   // startNode(node);
        //   // forEachChild(initializer, addChildrenRecursively);
        //   // endNode();
        // } else {
        //   // addNodeWithRecursiveChild(node, initializer);
        // }
        if (node.flags & (1 << 23)) {
          // 1 << 23 internally documented as "ambient" or global.
          writer
            .createSymbol(".", name.getText(sf))
            .explicitly()
            .ofType(SymbolKind.GLOBAL_VARIABLE)
            .atLocation(nodeToSourceRange(name, file))
            .withSignature(nodeToSourceRange(node.parent, file));
        } else {
          //temp:debugger;
        }
        break;

      case ts.SyntaxKind.FunctionDeclaration:
        const nameNode = (<ts.FunctionLikeDeclaration>node).name;
        // If we see a function declaration track as a possible ES5 class
        if (nameNode && ts.isIdentifier(nameNode)) {
          if (node.flags & (1 << 23)) {
            // 1 << 23 internally documented as "ambient" or global.
            writer
              .createSymbol(".", nameNode.getText(sf))
              .explicitly()
              .ofType(SymbolKind.GLOBAL_VARIABLE)
              .atLocation(nodeToSourceRange(nameNode, file))
              .withSignature(nodeToSourceRange(node.parent, file));
          } else {
            //temp:debugger;
          }
          // addTrackedEs5Class(nameNode.text);
        } else {
          //temp:debugger;
        }
        // addNodeWithRecursiveChild(
        //   node,
        //   (<ts.FunctionLikeDeclaration>node).body
        // );
        break;
      case ts.SyntaxKind.ArrowFunction:
      case ts.SyntaxKind.FunctionExpression:
        //temp:debugger;
        /*addNodeWithRecursiveChild(
              node,
              (<ts.FunctionLikeDeclaration>node).body
            );*/
        break;

      case ts.SyntaxKind.EnumDeclaration:
        //startNode(node);
        for (const member of (<ts.EnumDeclaration>node).members) {
          //temp:debugger;
          /*if (!ts.isComputedProperty(member)) {
                //addLeafNode(member);
              }*/
        }
        //endNode();
        break;

      case ts.SyntaxKind.ClassDeclaration:
      case ts.SyntaxKind.InterfaceDeclaration:
        //startNode(node);
        let symbol;
        if (node.flags & (1 << 23)) {
          // 1 << 23 internally documented as "ambient" or global.
          const name = (<ts.InterfaceDeclaration | ts.ClassDeclaration>node)
            .name;
          symbol = writer
            .createSymbol(".", name.getText(sf))
            .explicitly()
            .ofType(SymbolKind.GLOBAL_VARIABLE)
            .atLocation(nodeToSourceRange(name, file));
        } else {
          //temp:debugger;
        }
        // for (const member of (<ts.InterfaceDeclaration>node).members) {
        //   //addChildrenRecursively(member);
        //   symbol
        //     .createChildSymbol(member.name.getText(sf))
        //     .explicitly()
        //     .ofType(SymbolKind.FIELD)
        //     .atLocation(nodeToSourceRange(member.name, file))
        //     .withSignature(nodeToSourceRange(member, file));
        // }
        //endNode();
        break;
      case ts.SyntaxKind.ClassExpression:
        //temp:debugger;
        break;

      case ts.SyntaxKind.ModuleDeclaration:
        //temp:debugger;
        // addNodeWithRecursiveChild(
        //   node,
        //   getInteriorModule(<ts.ModuleDeclaration>node).body
        // );
        break;

      case ts.SyntaxKind.ExportSpecifier:
      case ts.SyntaxKind.ImportEqualsDeclaration:
      case ts.SyntaxKind.IndexSignature:
      case ts.SyntaxKind.CallSignature:
      case ts.SyntaxKind.ConstructSignature:
        //temp:debugger;
        //addLeafNode(node);
        break;

      case ts.SyntaxKind.TypeAliasDeclaration:
        const typeAlias = node as ts.TypeAliasDeclaration;
        if (typeAlias.flags & (1 << 23)) {
          const typeName = writer
            .createSymbol(".", typeAlias.name.getText(sf))
            .explicitly()
            .ofType(SymbolKind.GLOBAL_VARIABLE)
            .atLocation(nodeToSourceRange(typeAlias.name, file))
            .withSignature(nodeToSourceRange(typeAlias, file));
          writer
            .createSymbol(".", typeAlias.type.getText(sf))
            .explicitly()
            .ofType(SymbolKind.TYPEDEF)
            .atLocation(nodeToSourceRange(typeAlias.type, file))
            .isReferencedBy(typeName, ReferenceKind.USAGE);
        } else {
          //temp:debugger;
        }
        //addLeafNode(node);
        break;

      case ts.SyntaxKind.CallExpression:
      case ts.SyntaxKind.BinaryExpression:
        //temp:debugger;
        // const special = ts.getAssignmentDeclarationKind(
        //   node as ts.BinaryExpression
        // );
        break;
    }
    ts.forEachChild(node, n => this.visitTypeNodes(writer, file, n));
  }

  private processSourceFile(
    writer: SourcetrailDB,
    file: FileBuilder,
    sf: ts.SourceFile
  ) {
    sf.libReferenceDirectives.forEach(ref => {
      const refSourceFile: ts.SourceFile = (this
        .program as any).getLibFileFromReference(ref);
      this.addOrGetFile(writer, refSourceFile);
      const refFileSymbol = this.sourceFileToModuleSymbol(
        writer,
        refSourceFile,
        file
      );
      writer
        .createSymbol(`<reference lib="${ref.fileName}" />`)
        .explicitly()
        .ofType(SymbolKind.MACRO)
        .atLocation(libReferenceToSourceRange(ref, sf, file))
        .isReferencedBy(refFileSymbol, ReferenceKind.INCLUDE)
        .atLocation(libReferenceToSourceRange(ref, sf, file));
      // TODO: Use @internal pragmas or comment parsing to assign location start/end
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
      .withScope(nodeToSourceRange(sf, sfFile));
    for (let i = 0; i < filenameParts.length; i++) {
      if (filenameParts[i] === "node_modules") {
        writer
          .createSymbol("/", filenameParts.slice(i, i + 2))
          .explicitly()
          .ofType(SymbolKind.PACKAGE)
          .withScope(nodeToSourceRange(sf, sfFile))
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
          const file = indexer.addOrGetFile(writer, sf);
          indexer.processSourceFile(writer, file, sf);
          indexer.visitTypeNodes(writer, file, sf);
        });
      },
      clear
    );
  }
}
