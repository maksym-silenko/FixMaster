import * as assert from 'assert';
import { before, after } from 'mocha';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DataDictionary, normalizeDictionaryInput, resolveDictionaryPaths } from '../../quickFixDataDictionary';
import { Orchestra } from '../../fixOrchestra';
import { parseMessage, prettyPrintMessage } from '../../fixProtocol';
import { NameLookup } from '../../options';

suite('QuickFix XML Data Dictionary Test Suite', () => {

    let dictionary: DataDictionary;
    let tempDir: string;
    const singleFixturePath = path.join(__dirname, '../../../src/test/suite/FIX50SP2.xml');

    before(async () => {
        dictionary = await DataDictionary.parse(singleFixturePath);
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixmaster-qf-test-'));

        // Create test XML dictionaries and directory structure in tempDir
        const subDir = path.join(tempDir, 'specs');
        const nestedDir = path.join(subDir, 'custom');
        const ignoredNodeModules = path.join(tempDir, 'node_modules', 'pkg');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.mkdirSync(ignoredNodeModules, { recursive: true });

        // Base dictionary 01_base.xml
        fs.writeFileSync(
            path.join(subDir, '01_base.xml'),
            `<fix type="FIX" major="4" minor="4" servicepack="0">
                <header>
                    <field name="BeginString" required="Y"/>
                </header>
                <messages>
                    <message name="Logon" msgtype="A" msgcat="admin">
                        <field name="EncryptMethod" required="Y"/>
                        <field name="CustomTagA" required="N"/>
                    </message>
                </messages>
                <components/>
                <fields>
                    <field number="8" name="BeginString" type="STRING"/>
                    <field number="98" name="EncryptMethod" type="INT">
                        <value enum="0" description="NONE"/>
                    </field>
                    <field number="20001" name="CustomTagA" type="STRING">
                        <value enum="1" description="ALPHA"/>
                    </field>
                    <field number="20002" name="SharedTag" type="STRING"/>
                </fields>
            </fix>`,
            'utf8'
        );

        // Second dictionary 02_override.xml with new tags and a conflicting definition for 20001
        fs.writeFileSync(
            path.join(subDir, '02_override.xml'),
            `<fix type="FIX" major="4" minor="4" servicepack="0">
                <messages>
                    <message name="CustomLogon" msgtype="A" msgcat="admin">
                        <field name="EncryptMethod" required="Y"/>
                        <field name="CustomTagA_Overridden" required="Y"/>
                        <field name="CustomTagB" required="N"/>
                    </message>
                </messages>
                <fields>
                    <field number="20001" name="CustomTagA_Overridden" type="INT">
                        <value enum="1" description="ALPHA_OVERRIDDEN"/>
                        <value enum="2" description="BETA"/>
                    </field>
                    <field number="20002" name="SharedTag" type="STRING"/>
                    <field number="20003" name="CustomTagB" type="PRICE"/>
                </fields>
            </fix>`,
            'utf8'
        );

        // Nested partial dictionary (fields only, high tag number 65535)
        fs.writeFileSync(
            path.join(nestedDir, '03_venue.xml'),
            `<fix>
                <fields>
                    <field number="65535" name="VenueUserTag" type="STRING"/>
                </fields>
            </fix>`,
            'utf8'
        );

        // Non-XML file that should be ignored by filtering
        fs.writeFileSync(path.join(subDir, 'notes.txt'), 'not an xml file', 'utf8');

        // Non-QuickFIX XML file (no <fix> root)
        fs.writeFileSync(path.join(subDir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>', 'utf8');

        // Malformed XML file
        fs.writeFileSync(path.join(nestedDir, 'broken.xml'), '<fix><fields><field number="1"</fix>', 'utf8');

        // XML inside node_modules that should be ignored by default globbing
        fs.writeFileSync(
            path.join(ignoredNodeModules, 'ignored.xml'),
            `<fix><fields><field number="29999" name="ShouldBeIgnored" type="STRING"/></fields></fix>`,
            'utf8'
        );
    });

    after(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    test('Version (legacy single direct file path)', () => {
        assert.equal('FIX', dictionary.type);
        assert.equal(5, dictionary.major);
        assert.equal(0, dictionary.minor);
        assert.equal(2, dictionary.servicePack);
        assert.equal(1, dictionary.sourceFiles.length);
    });

    test('Fields parse (legacy single direct file path)', () => {
        assert.equal(1618, dictionary.fields.length);
    });

    test('Value description lookup', () => {
        assert.equal("FILLED", dictionary.descriptionOfValue(39, "2"));
        assert.equal("ACCEPTED_FOR_BIDDING", dictionary.descriptionOfValue(39, "D"));
    });

    test('Message lookup', () => {
        const message = dictionary.definitionOfMessage("D");
        assert.equal("NewOrderSingle", message.name);
        assert.equal("app", message.categoryID);
    });

    test('Normalize dictionary input handles string, array, null, and empty values', () => {
        assert.deepEqual(normalizeDictionaryInput(null), []);
        assert.deepEqual(normalizeDictionaryInput(undefined), []);
        assert.deepEqual(normalizeDictionaryInput('   '), []);
        assert.deepEqual(normalizeDictionaryInput(' /path/to/a.xml '), ['/path/to/a.xml']);
        assert.deepEqual(
            normalizeDictionaryInput([' /path/a.xml ', '', '   ', 'specs/*.xml']),
            ['/path/a.xml', 'specs/*.xml']
        );
    });

    test('Array of direct file paths merges definitions and deduplicates paths', async () => {
        const file1 = path.join(tempDir, 'specs', '01_base.xml');
        const file3 = path.join(tempDir, 'specs', 'custom', '03_venue.xml');

        // Include duplicate file1 to verify deduplication
        const resolved = resolveDictionaryPaths([file1, file3, file1]);
        assert.deepEqual(resolved, [file1, file3]);

        const merged = await DataDictionary.parse([file1, file3]);
        assert.equal(2, merged.sourceFiles.length);

        const tagA = merged.definitionOfField(20001, undefined, undefined);
        assert.equal('CustomTagA', tagA.field.name);
        assert.equal('STRING', tagA.field.type);

        const highTag = merged.definitionOfField(65535, undefined, undefined);
        assert.equal('VenueUserTag', highTag.field.name);
        assert.equal('STRING', highTag.field.type);
    });

    test('Glob patterns match single and multiple XML files, excluding non-XML and node_modules', () => {
        // Single-match glob
        const singleMatch = resolveDictionaryPaths('specs/01_*.xml', { workspaceRoot: tempDir });
        assert.deepEqual(singleMatch, [path.join(tempDir, 'specs', '01_base.xml')]);

        // Multi-match glob in directory (lexical order)
        const dirGlobMatches = resolveDictionaryPaths('specs/0*.xml', { workspaceRoot: tempDir });
        assert.deepEqual(dirGlobMatches, [
            path.join(tempDir, 'specs', '01_base.xml'),
            path.join(tempDir, 'specs', '02_override.xml')
        ]);

        // Brace expansion glob
        const braceMatches = resolveDictionaryPaths('specs/{01_base,02_override}.xml', { workspaceRoot: tempDir });
        assert.deepEqual(braceMatches, [
            path.join(tempDir, 'specs', '01_base.xml'),
            path.join(tempDir, 'specs', '02_override.xml')
        ]);

        // Recursive **/*.xml glob with ${workspaceFolder} variable (ignores node_modules and notes.txt)
        const recursiveMatches = resolveDictionaryPaths('${workspaceFolder}/**/*.xml', { workspaceRoot: tempDir });
        assert(recursiveMatches.includes(path.join(tempDir, 'specs', '01_base.xml')));
        assert(recursiveMatches.includes(path.join(tempDir, 'specs', '02_override.xml')));
        assert(recursiveMatches.includes(path.join(tempDir, 'specs', 'custom', '03_venue.xml')));
        assert(!recursiveMatches.some(p => p.includes('node_modules')));
        assert(!recursiveMatches.some(p => p.endsWith('notes.txt')));
    });

    test('Non-existent files, invalid globs, and malformed XMLs are handled gracefully without crashing', async () => {
        const warnings: string[] = [];
        const dict = await DataDictionary.parse(
            [
                path.join(tempDir, 'specs', 'does_not_exist.xml'),
                path.join(tempDir, 'specs', 'notes.txt'),
                path.join(tempDir, 'specs', '[unclosed_glob.xml'),
                path.join(tempDir, 'specs', '{unclosed_brace.xml'),
                path.join(tempDir, 'non_existent_dir', '*.xml'),
                path.join(tempDir, 'specs', 'pom.xml'),
                path.join(tempDir, 'specs', 'custom', 'broken.xml'),
                path.join(tempDir, 'specs', '01_base.xml')
            ],
            {
                workspaceRoot: tempDir,
                onWarning: (msg) => warnings.push(msg)
            }
        );

        // Valid file in the list is still parsed despite earlier invalid entries
        assert.equal(1, dict.sourceFiles.length);
        assert.equal('CustomTagA', dict.definitionOfField(20001, undefined, undefined).field.name);

        // Warnings were logged for each invalid input
        assert(warnings.some(w => w.includes('does_not_exist.xml')));
        assert(warnings.some(w => w.includes('Skipping non-XML')));
        assert(warnings.some(w => w.includes('Invalid glob pattern')));
        assert(warnings.some(w => w.includes('pom.xml')));
        assert(warnings.some(w => w.includes('broken.xml')));

        // Completely empty / non-matching input returns an empty DataDictionary without throwing
        const emptyDict = await DataDictionary.parse(
            path.join(tempDir, 'specs', 'missing.xml'),
            { onWarning: () => {} }
        );
        assert.equal(0, emptyDict.sourceFiles.length);
        assert.equal('', emptyDict.definitionOfField(20001, undefined, undefined).field.name);
    });

    test('Tag collision behavior, deterministic precedence, and warning logging', async () => {
        const warnings: string[] = [];
        const file1 = path.join(tempDir, 'specs', '01_base.xml');
        const file2 = path.join(tempDir, 'specs', '02_override.xml');

        // Case 1: [01_base, 02_override] -> 02_override wins
        const forwardMerged = await DataDictionary.parse([file1, file2], {
            onWarning: (msg) => warnings.push(msg)
        });

        const overriddenField = forwardMerged.definitionOfField(20001, undefined, undefined);
        assert.equal('CustomTagA_Overridden', overriddenField.field.name);
        assert.equal('INT', overriddenField.field.type);
        assert.equal('ALPHA_OVERRIDDEN', forwardMerged.descriptionOfValue(20001, '1'));
        assert.equal('BETA', forwardMerged.descriptionOfValue(20001, '2'));
        assert.equal('CustomLogon', forwardMerged.definitionOfMessage('A').name);

        // Conflicting tag 20001, enum 20001=1, and message A should log warnings
        assert(warnings.some(w => w.includes('Conflicting QuickFix field definition for tag 20001')));
        assert(warnings.some(w => w.includes("Conflicting QuickFix enum definition for tag 20001 value '1'")));
        assert(warnings.some(w => w.includes("Conflicting QuickFix message definition for msgType 'A'")));
        // Identical tag 20002 (SharedTag) should NOT log a conflict warning
        assert(!warnings.some(w => w.includes('tag 20002')));

        // Case 2: Reverse array order [02_override, 01_base] -> 01_base wins
        const reverseWarnings: string[] = [];
        const reverseMerged = await DataDictionary.parse([file2, file1], {
            onWarning: (msg) => reverseWarnings.push(msg)
        });
        const baseWinsField = reverseMerged.definitionOfField(20001, undefined, undefined);
        assert.equal('CustomTagA', baseWinsField.field.name);
        assert.equal('STRING', baseWinsField.field.type);
        assert.equal('ALPHA', reverseMerged.descriptionOfValue(20001, '1'));
        // Enum value '2' from 02_override is still retained since 01_base didn't redefine value '2'
        assert.equal('BETA', reverseMerged.descriptionOfValue(20001, '2'));
        assert.equal('Logon', reverseMerged.definitionOfMessage('A').name);
    });

    test('Merged dictionaries eliminate "fields without name" during FIX message formatting', async () => {
        const orchestra = await Orchestra.load(path.join(__dirname, '../../../orchestrations'));
        orchestra.nameLookup = NameLookup.Strict;

        const merged = await DataDictionary.parse(
            ['specs/0*.xml', 'specs/custom/03_venue.xml'],
            { workspaceRoot: tempDir, onWarning: () => {} }
        );

        // Message containing standard tags + custom tags from multiple XML files (20001, 20003, 65535)
        const rawFix = '8=FIX.4.4|9=95|35=A|49=CLIENT|56=SERVER|34=1|52=20261016-20:00:00.100|98=0|108=30|20001=1|20003=100.5|65535=Maksym|10=123|';
        const parsed = parseMessage(rawFix, orchestra, '|');
        assert(parsed, 'Message should parse');

        // Without QuickFIX dictionary, custom tags have empty names
        const descWithoutQf = parsed.describe(orchestra, null);
        assert.equal('', descWithoutQf.fields.find(f => f.tag === 20001)?.name);
        assert.equal('', descWithoutQf.fields.find(f => f.tag === 20003)?.name);
        assert.equal('', descWithoutQf.fields.find(f => f.tag === 65535)?.name);

        // With merged QuickFIX dictionaries, all tags have resolved names and enum descriptions
        const descWithQf = parsed.describe(orchestra, merged);
        assert.equal('CustomTagA_Overridden', descWithQf.fields.find(f => f.tag === 20001)?.name);
        assert.equal('ALPHA_OVERRIDDEN', descWithQf.fields.find(f => f.tag === 20001)?.valueDescription);
        assert.equal('CustomTagB', descWithQf.fields.find(f => f.tag === 20003)?.name);
        assert.equal('VenueUserTag', descWithQf.fields.find(f => f.tag === 65535)?.name);

        const pretty = prettyPrintMessage('', parsed, orchestra, merged, 0);
        assert(pretty.includes('CustomTagA_Overridden (20001) 1 - ALPHA_OVERRIDDEN'));
        assert(pretty.includes('CustomTagB (20003) 100.5'));
        assert(pretty.includes('VenueUserTag (65535) Maksym'));
    });

});