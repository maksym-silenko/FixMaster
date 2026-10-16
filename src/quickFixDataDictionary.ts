import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';
import { Enum, Field, MessageField, Message } from './definitions';

/*

<fix major="4" minor="4">
    <header>
        <field name="BeginString" required="Y"/>
        <group name="NoHops" required="N">
            <field name="HopCompID" required="N"/>
        </group>
    </header>
    <trailer>
        <field name="SignatureLength" required="N"/>
        <group/>
    </trailer>
    <messages>
        <message name="Heartbeat" msgtype="0" msgcat="admin">
            <field name="TestReqID" required="N"/>
            <component name="Instrument" required="Y"/>
            <group name="NoMsgTypes" required="N">
                <field name="RefMsgType" required="N"/>
                <component name="UnderlyingInstrument" required="N"/>
            </group>
        </message>
    </messages>
    <components>
        <component name="Instrument">
            <field name="Symbol" required="Y"/>
            <group name="NoSecurityAltID" required="N">
                <field name="SecurityAltID" required="N"/>
            <group>
            <component/>
        </component>
    </components>
    <fields>
        <field number="4" name="AdvSide" type="CHAR">
            <value enum="B" description="BUY"/>
        </field>
    </fields>
</fix>

*/

// Typed shapes for the xml2js-parsed QuickFIX XML data dictionary.
// xml2js is configured with explicitChildren:true and preserveChildrenOrder:true.

interface QfAttrs {
    [key: string]: string;
}

interface QfValue {
    $: QfAttrs & { enum: string; description: string };
}

interface QfField {
    $: QfAttrs & { number: string; name: string; type: string };
    value?: QfValue[];
}

// A child element inside a message, component, or group (field/component/group refs).
interface QfChild {
    $: QfAttrs & { name?: string; required?: string };
    '#name': string;
    $$?: QfChild[];
}

interface QfComponent {
    $: QfAttrs & { name: string };
    $$?: QfChild[];
}

interface QfMessage {
    $: QfAttrs & { msgtype: string; name: string; msgcat: string };
    $$?: QfChild[];
}

interface QfJson {
    fix?: {
        $?: QfAttrs & { type?: string; major?: string; minor?: string; servicepack?: string };
        fields?: Array<{ field?: QfField[] }>;
        components?: Array<{ component?: QfComponent[] }>;
        messages?: Array<{ message?: QfMessage[] }>;
    };
}

export interface DataDictionaryOptions {
    workspaceRoot?: string;
    onWarning?: (message: string) => void;
    maxDepth?: number;
    ignoreDirs?: string[];
}

const DEFAULT_IGNORE_DIRS = new Set([
    'node_modules',
    '.git',
    '.vscode-test',
    'out',
    'dist'
]);

const DEFAULT_MAX_DEPTH = 20;
const MAX_DENSE_FIELD_TAG = 100000;
const EMPTY_FIELD = new Field(0, "", "");

/**
 * Normalizes the configuration input into an array of trimmed, non-empty path/glob strings.
 */
export function normalizeDictionaryInput(input: string | string[] | null | undefined): string[] {
    if (!input) {
        return [];
    }
    if (typeof input === 'string') {
        const trimmed = input.trim();
        return trimmed.length > 0 ? [trimmed] : [];
    }
    if (Array.isArray(input)) {
        const result: string[] = [];
        for (const item of input) {
            if (typeof item === 'string') {
                const trimmed = item.trim();
                if (trimmed.length > 0) {
                    result.push(trimmed);
                }
            }
        }
        return result;
    }
    return [];
}

function toPosixPath(p: string): string {
    return p.split(path.sep).join('/');
}

function hasGlobMagic(pattern: string): boolean {
    return /[*?[\]{}]/.test(pattern);
}

function isValidGlobSyntax(pattern: string): boolean {
    let inBracket = false;
    let braceDepth = 0;

    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            i++;
            continue;
        }
        if (ch === '[' && !inBracket) {
            inBracket = true;
        } else if (ch === ']' && inBracket) {
            inBracket = false;
        } else if (ch === '{' && !inBracket) {
            braceDepth++;
        } else if (ch === '}' && !inBracket) {
            braceDepth--;
            if (braceDepth < 0) {
                return false;
            }
        }
    }

    if (inBracket || braceDepth !== 0) {
        return false;
    }

    // Reject empty brackets like []
    if (/\[\]/.test(pattern)) {
        return false;
    }

    return true;
}

function globToRegExp(globPattern: string): RegExp {
    let regexStr = '^';
    let i = 0;
    const len = globPattern.length;

    while (i < len) {
        const ch = globPattern[i];

        if (ch === '*') {
            if (globPattern[i + 1] === '*') {
                // Handle **/ or /** or **
                if (globPattern[i + 2] === '/') {
                    regexStr += '(?:.+/)?';
                    i += 3;
                    continue;
                } else {
                    regexStr += '.*';
                    i += 2;
                    continue;
                }
            } else {
                regexStr += '[^/]*';
                i++;
                continue;
            }
        }

        if (ch === '?') {
            regexStr += '[^/]';
            i++;
            continue;
        }

        if (ch === '[') {
            const closeIdx = globPattern.indexOf(']', i + 1);
            if (closeIdx === -1) {
                throw new Error(`Unclosed character class in glob '${globPattern}'`);
            }
            let content = globPattern.slice(i + 1, closeIdx);
            if (content.startsWith('!')) {
                content = '^' + content.slice(1);
            }
            regexStr += '[' + content + ']';
            i = closeIdx + 1;
            continue;
        }

        if (ch === '{') {
            const closeIdx = globPattern.indexOf('}', i + 1);
            if (closeIdx === -1) {
                throw new Error(`Unclosed brace expansion in glob '${globPattern}'`);
            }
            const options = globPattern
                .slice(i + 1, closeIdx)
                .split(',')
                .map(opt => opt.replace(/[.+^$()|[\]\\]/g, '\\$&'));
            regexStr += '(?:' + options.join('|') + ')';
            i = closeIdx + 1;
            continue;
        }

        if (/[.+^$()|\\]/.test(ch)) {
            regexStr += '\\' + ch;
        } else {
            regexStr += ch;
        }
        i++;
    }

    regexStr += '$';
    return new RegExp(regexStr);
}

function splitBaseAndGlob(resolvedPattern: string): { baseDir: string; relativeGlob: string } {
    const normalized = path.normalize(resolvedPattern);
    const parts = normalized.split(path.sep);
    const baseParts: string[] = [];
    let globStartIndex = parts.length;

    for (let i = 0; i < parts.length; i++) {
        if (hasGlobMagic(parts[i])) {
            globStartIndex = i;
            break;
        }
        baseParts.push(parts[i]);
    }

    let baseDir = baseParts.join(path.sep);
    if (baseDir === '' && path.isAbsolute(normalized)) {
        baseDir = path.sep;
    } else if (baseDir === '') {
        baseDir = '.';
    }

    const relativeGlob = parts.slice(globStartIndex).join('/');
    return { baseDir, relativeGlob };
}

function walkXmlFiles(
    baseDir: string,
    currentRelPosix: string,
    depth: number,
    maxDepth: number,
    ignoreDirs: Set<string>,
    matcher: RegExp,
    results: string[],
    warn: (msg: string) => void
) {
    if (depth > maxDepth) {
        return;
    }

    const currentFullDir = currentRelPosix
        ? path.join(baseDir, ...currentRelPosix.split('/'))
        : baseDir;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(currentFullDir, { withFileTypes: true });
    } catch (err) {
        warn(`Unable to read directory '${currentFullDir}': ${err}`);
        return;
    }

    for (const entry of entries) {
        const relPosix = currentRelPosix ? `${currentRelPosix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            if (ignoreDirs.has(entry.name)) {
                continue;
            }
            walkXmlFiles(baseDir, relPosix, depth + 1, maxDepth, ignoreDirs, matcher, results, warn);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            if (!entry.name.toLowerCase().endsWith('.xml')) {
                continue;
            }
            const fullPath = path.resolve(currentFullDir, entry.name);
            try {
                const stat = fs.statSync(fullPath);
                if (!stat.isFile()) {
                    continue;
                }
            } catch {
                continue;
            }
            if (matcher.test(relPosix)) {
                results.push(fullPath);
            }
        }
    }
}

/**
 * Resolves a single path/glob string or array of path/glob strings into a deduplicated,
 * deterministically ordered list of existing `.xml` file paths.
 */
export function resolveDictionaryPaths(
    input: string | string[] | null | undefined,
    options?: DataDictionaryOptions
): string[] {
    const warn = options?.onWarning ?? ((msg: string) => console.warn(msg));
    const workspaceRoot = options?.workspaceRoot;
    const maxDepth = options?.maxDepth ?? DEFAULT_MAX_DEPTH;
    const ignoreDirs = options?.ignoreDirs ? new Set(options.ignoreDirs) : DEFAULT_IGNORE_DIRS;

    const rawPatterns = normalizeDictionaryInput(input);
    const resolvedFiles: string[] = [];
    const seen = new Set<string>();

    for (const rawPattern of rawPatterns) {
        let pattern = rawPattern;

        if (pattern.includes('${workspaceFolder}')) {
            if (!workspaceRoot) {
                warn(`Unable to resolve \${workspaceFolder} in '${rawPattern}' - no workspace root is available.`);
                continue;
            }
            pattern = pattern.replace(/\$\{workspaceFolder\}/g, workspaceRoot);
        }

        const baseRoot = workspaceRoot ?? process.cwd();
        const absolutePattern = path.isAbsolute(pattern)
            ? pattern
            : path.resolve(baseRoot, pattern);

        if (!hasGlobMagic(absolutePattern)) {
            const normalizedPath = path.resolve(absolutePattern);
            if (!normalizedPath.toLowerCase().endsWith('.xml')) {
                warn(`Skipping non-XML QuickFix data dictionary path '${rawPattern}'.`);
                continue;
            }
            try {
                if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isFile()) {
                    warn(`The QuickFix data dictionary path '${normalizedPath}' cannot be found.`);
                    continue;
                }
            } catch (err) {
                warn(`Unable to access QuickFix data dictionary path '${normalizedPath}': ${err}`);
                continue;
            }
            if (!seen.has(normalizedPath)) {
                seen.add(normalizedPath);
                resolvedFiles.push(normalizedPath);
            }
            continue;
        }

        // Validate glob syntax before attempting compilation
        const posixPattern = toPosixPath(absolutePattern);
        if (!isValidGlobSyntax(posixPattern)) {
            warn(`Invalid glob pattern '${rawPattern}'.`);
            continue;
        }

        const { baseDir, relativeGlob } = splitBaseAndGlob(absolutePattern);
        try {
            if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) {
                warn(`No QuickFix XML files matched pattern '${rawPattern}' (base directory '${baseDir}' does not exist).`);
                continue;
            }
        } catch (err) {
            warn(`Unable to access base directory '${baseDir}' for pattern '${rawPattern}': ${err}`);
            continue;
        }

        let matcher: RegExp;
        try {
            matcher = globToRegExp(relativeGlob);
        } catch (err) {
            warn(`Invalid glob pattern '${rawPattern}': ${err}`);
            continue;
        }

        const matchedForPattern: string[] = [];
        walkXmlFiles(baseDir, '', 0, maxDepth, ignoreDirs, matcher, matchedForPattern, warn);

        // Sort lexicographically for deterministic ordering within each glob expansion
        matchedForPattern.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        if (matchedForPattern.length === 0) {
            warn(`No QuickFix XML files matched pattern '${rawPattern}'.`);
            continue;
        }

        for (const file of matchedForPattern) {
            if (!seen.has(file)) {
                seen.add(file);
                resolvedFiles.push(file);
            }
        }
    }

    return resolvedFiles;
}

export class DataDictionary {

    constructor(readonly type: string,
                readonly major: number,
                readonly minor: number,
                readonly servicePack: number,
                readonly fields: Field[],
                readonly fieldsByName: Record<string, Field>,
                enums: Enum[],
                messages: Message[],
                readonly sourceFiles: string[] = [],
                private readonly sparseFields: Map<number, Field> = new Map()) {
        this.beginString = `${this.type}.${this.major}.${this.minor}SP${this.servicePack}`;

        enums.forEach(entry => {
            if (this.enums[entry.tag]) {
                this.enums[entry.tag].push(entry);
            }
            else {
                this.enums[entry.tag] = [entry];
            }
        });

        messages.forEach(message => this.messages[message.msgType] = message);
    }

    readonly beginString: string;
    readonly enums: Record<number, Enum[]> = {};
    readonly messages: Record<string, Message> = {};

    definitionOfField(tag: number, _beginString: string | undefined, message: Message | undefined) {
        if (message) {
            const msgField = message.fields.find(f => f.field.tag === tag);
            if (msgField && msgField.field.name.length > 0) {
                return msgField;
            }
        }
        if (tag > 0 && tag < this.fields.length) {
            const field = this.fields[tag];
            if (field && field.tag === tag && field.name.length > 0) {
                return new MessageField(field, false, "", 0);
            }
        }
        const sparse = this.sparseFields.get(tag);
        if (sparse) {
            return new MessageField(sparse, false, "", 0);
        }
        return new MessageField(new Field(NaN, "", "", undefined, undefined, undefined), false, "", 0);
    }

    definitionOfMessage(msgType: string) {

        const message = this.messages[msgType];
        if (message) {
            return message;
        }

        // Always return a valid object to simplify calling code.
        return new Message("", msgType, "", "", "", "", "", "", []);
    }

    descriptionOfValue(tag: number, value: string) {

        const enums = this.enums[tag];

        if (enums) {
            const definition = enums.find(e => e.value === value);
            if (definition) {
                return definition.symbolicName;
            }
        }

        return "";
    }

    isFieldEnumerated(tag: number): boolean {
        const enums = this.enums[tag];
        return Boolean(enums && enums.length > 0);
    }

    static async parse(pathOrPaths: string | string[], options?: DataDictionaryOptions): Promise<DataDictionary> {
        const warn = options?.onWarning ?? ((msg: string) => console.warn(msg));
        const resolvedFiles = resolveDictionaryPaths(pathOrPaths, options);

        if (resolvedFiles.length === 0) {
            return new DataDictionary("", 0, 0, 0, [], {}, [], [], []);
        }

        let type = "";
        let major = 0;
        let minor = 0;
        let servicePack = 0;

        const fieldsMap = new Map<number, { field: Field; source: string }>();
        const fieldsByName: Record<string, Field> = {};
        const enumsByTag = new Map<number, Map<string, { enumObj: Enum; source: string }>>();
        const componentsByName: Record<string, QfComponent> = {};
        const rawMessagesByType = new Map<string, { element: QfMessage; source: string }>();
        const loadedFiles: string[] = [];

        for (const filename of resolvedFiles) {
            let json: QfJson;
            try {
                json = await xml2json(filename);
            } catch (err) {
                warn(`Unable to parse XML file '${filename}': ${err}`);
                continue;
            }

            if (!json || !json.fix) {
                warn(`Skipping '${filename}': root <fix> element not found.`);
                continue;
            }

            loadedFiles.push(filename);

            if (json.fix.$) {
                if (json.fix.$.type !== undefined) {
                    type = json.fix.$.type;
                }
                if (json.fix.$.major !== undefined) {
                    major = Number(json.fix.$.major);
                }
                if (json.fix.$.minor !== undefined) {
                    minor = Number(json.fix.$.minor);
                }
                if (json.fix.$.servicepack !== undefined) {
                    servicePack = Number(json.fix.$.servicepack);
                }
            }

            const rawFields = json.fix.fields?.[0]?.field;
            if (Array.isArray(rawFields)) {
                rawFields.forEach((element: QfField) => {
                    if (!element.$) {
                        return;
                    }
                    const tag = Number(element.$.number);
                    const fieldName = element.$.name;
                    const fieldType = element.$.type ?? "";
                    if (isNaN(tag) || tag <= 0 || !fieldName) {
                        return;
                    }

                    const field = new Field(tag, fieldName, fieldType);
                    const existing = fieldsMap.get(tag);
                    if (existing) {
                        if (existing.field.name !== field.name || existing.field.type !== field.type) {
                            warn(
                                `Conflicting QuickFix field definition for tag ${tag}: ` +
                                `'${existing.field.name}' (${existing.field.type}) from '${existing.source}' ` +
                                `overridden by '${field.name}' (${field.type}) from '${filename}'.`
                            );
                            if (existing.field.name !== field.name && fieldsByName[existing.field.name]?.tag === tag) {
                                delete fieldsByName[existing.field.name];
                            }
                        }
                    }

                    fieldsMap.set(tag, { field, source: filename });
                    fieldsByName[field.name] = field;

                    if (Array.isArray(element.value)) {
                        let tagEnums = enumsByTag.get(tag);
                        if (!tagEnums) {
                            tagEnums = new Map();
                            enumsByTag.set(tag, tagEnums);
                        }
                        element.value.forEach((value: QfValue) => {
                            if (!value.$ || value.$.enum === undefined) {
                                return;
                            }
                            const enumValue = value.$.enum;
                            const enumDesc = value.$.description ?? "";
                            const newEnum = new Enum(tag, enumValue, enumDesc);
                            const existingEnum = tagEnums!.get(enumValue);
                            if (existingEnum && existingEnum.enumObj.symbolicName !== newEnum.symbolicName) {
                                warn(
                                    `Conflicting QuickFix enum definition for tag ${tag} value '${enumValue}': ` +
                                    `'${existingEnum.enumObj.symbolicName}' from '${existingEnum.source}' ` +
                                    `overridden by '${newEnum.symbolicName}' from '${filename}'.`
                                );
                            }
                            tagEnums!.set(enumValue, { enumObj: newEnum, source: filename });
                        });
                    }
                });
            }

            const rawComponents = json.fix.components?.[0]?.component;
            if (Array.isArray(rawComponents)) {
                rawComponents.forEach((element: QfComponent) => {
                    if (element.$?.name) {
                        componentsByName[element.$.name] = element;
                    }
                });
            }

            const rawMessages = json.fix.messages?.[0]?.message;
            if (Array.isArray(rawMessages)) {
                rawMessages.forEach((element: QfMessage) => {
                    if (!element.$?.msgtype) {
                        return;
                    }
                    const msgType = element.$.msgtype;
                    const existingMsg = rawMessagesByType.get(msgType);
                    if (existingMsg) {
                        if (
                            existingMsg.element.$.name !== element.$.name ||
                            existingMsg.element.$.msgcat !== element.$.msgcat
                        ) {
                            warn(
                                `Conflicting QuickFix message definition for msgType '${msgType}': ` +
                                `'${existingMsg.element.$.name}' (${existingMsg.element.$.msgcat}) from '${existingMsg.source}' ` +
                                `overridden by '${element.$.name}' (${element.$.msgcat}) from '${filename}'.`
                            );
                        }
                    }
                    rawMessagesByType.set(msgType, { element, source: filename });
                });
            }
        }

        // Field tags are 1-based and there are gaps in the sequence; populate dense array up to
        // MAX_DENSE_FIELD_TAG for constant-time lookup, and store any higher tags in sparseFields.
        let maxDenseTag = -1;
        const sparseFields = new Map<number, Field>();

        for (const [tag, entry] of fieldsMap.entries()) {
            if (tag <= MAX_DENSE_FIELD_TAG) {
                if (tag > maxDenseTag) {
                    maxDenseTag = tag;
                }
            } else {
                sparseFields.set(tag, entry.field);
            }
        }

        const fields: Field[] = [];
        if (maxDenseTag >= 0) {
            for (let i = 0; i <= maxDenseTag; i++) {
                const entry = fieldsMap.get(i);
                fields.push(entry ? entry.field : EMPTY_FIELD);
            }
            if (!fieldsByName[""]) {
                fieldsByName[""] = EMPTY_FIELD;
            }
        }

        const enums: Enum[] = [];
        for (const tagEnums of enumsByTag.values()) {
            for (const entry of tagEnums.values()) {
                enums.push(entry.enumObj);
            }
        }

        const messages: Message[] = [];
        for (const { element } of rawMessagesByType.values()) {
            const messageFields: MessageField[] = [];

            const processChildren = (
                children: QfChild[] | undefined | null,
                indent: number,
                visitedComponents: Set<string>
            ) => {
                if (!children) {
                    return;
                }
                children.forEach((child: QfChild) => {
                    switch (child["#name"]) {
                        case "field": {
                            const name = child.$?.name;
                            const required = child.$?.required === 'Y';
                            const field = name ? fieldsByName[name] : undefined;
                            if (field) {
                                messageFields.push(new MessageField(field, required, "", indent));
                            }
                            break;
                        }
                        case "component": {
                            const name = child.$?.name;
                            if (name && !visitedComponents.has(name)) {
                                const comp = componentsByName[name];
                                if (comp) {
                                    visitedComponents.add(name);
                                    processChildren(comp.$$, indent, visitedComponents);
                                    visitedComponents.delete(name);
                                }
                            }
                            break;
                        }
                        case "group": {
                            const name = child.$?.name;
                            const required = child.$?.required === 'Y';
                            const groupCountField = name ? fieldsByName[name] : undefined;
                            if (groupCountField) {
                                messageFields.push(new MessageField(groupCountField, required, "", indent));
                            }
                            processChildren(child.$$, indent + 1, visitedComponents);
                            break;
                        }
                    }
                });
            };

            processChildren(element.$$, 0, new Set<string>());

            const message = new Message(
                "",
                element.$.msgtype,
                element.$.name ?? "",
                element.$.msgcat ?? "",
                "",
                "",
                "",
                "",
                messageFields
            );

            messages.push(message);
        }

        return new DataDictionary(
            type,
            major,
            minor,
            servicePack,
            fields,
            fieldsByName,
            enums,
            messages,
            loadedFiles,
            sparseFields
        );
    }

}

async function xml2json(filename: string): Promise<QfJson> {
    return new Promise<QfJson>((resolve, reject) => {
        let xml: Buffer;
        try {
            xml = fs.readFileSync(filename);
        } catch (err) {
            reject(err);
            return;
        }
        const parser = new xml2js.Parser({
            explicitChildren: true,
            preserveChildrenOrder: true
        });
        parser.parseString(xml, function (err: unknown, json: QfJson) {
            if (err) {
                reject(err);
            }
            else {
                resolve(json);
            }
        });
    });
}

