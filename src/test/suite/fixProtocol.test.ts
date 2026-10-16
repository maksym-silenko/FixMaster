import * as assert from 'assert';
import { before } from 'mocha';
import * as path from 'path';
import { Orchestra } from '../../fixOrchestra';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../extension';

import { parseMessage, parsePrettyPrintedField } from '../../fixProtocol';

suite('FIX Protocol Test Suite', () => {

    let orchestra: Orchestra;

    before(async () => {
		vscode.window.showInformationMessage('Start all tests.');
        orchestra = await Orchestra.load(path.join(__dirname, "../../../orchestrations"));
	});

	test('Parse Message', () => {
        const text = "8=FIX.4.49=7235=A49=ACCEPTOR56=INITIATOR34=152=20190816-10:34:27.74298=0108=3010=012";
        const message = parseMessage(text);
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(10, message.fields.length);
        assert.equal(8, message.fields[0].tag);
        assert.equal("INITIATOR", message.fields[4].value);
    });

    test('Parse Message Wtih Custom Field Delimiter', () => {
        const text = "8=FIX.4.4|9=72|35=A|49=ACCEPTOR|56=INITIATOR|34=1|52=20190816-10:34:27.742|98=0|108=30|10=012|";
        const message = parseMessage(text, null, "|");
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(10, message.fields.length);
        assert.equal(8, message.fields[0].tag);
        assert.equal("INITIATOR", message.fields[4].value);
    });

    test('Parse Message With List Of Field Delimiters', () => {
        const pipeText = "8=FIX.4.4|9=72|35=A|49=ACCEPTOR|56=INITIATOR|34=1|52=20190816-10:34:27.742|98=0|108=30|10=012|";
        const caretAText = "8=FIX.4.4^A9=72^A35=A^A49=ACCEPTOR^A56=INITIATOR^A34=1^A52=20190816-10:34:27.742^A98=0^A108=30^A10=012^A";
        const sohText = "8=FIX.4.4\x019=72\x0135=A\x0149=ACCEPTOR\x0156=INITIATOR\x0134=1\x0152=20190816-10:34:27.742\x0198=0\x01108=30\x0110=012\x01";
        const separators = ["|", "^A"];

        const pipeMessage = parseMessage(pipeText, null, separators);
        assert(pipeMessage, "pipe message failed to parse");
        assert.equal(10, pipeMessage.fields.length);
        assert.equal("INITIATOR", pipeMessage.fields[4].value);

        const caretAMessage = parseMessage(caretAText, null, separators);
        assert(caretAMessage, "^A message failed to parse");
        assert.equal(10, caretAMessage.fields.length);
        assert.equal("INITIATOR", caretAMessage.fields[4].value);

        const sohMessage = parseMessage(sohText, null, separators);
        assert(sohMessage, "SOH message failed to parse when custom separators list is provided");
        assert.equal(10, sohMessage.fields.length);
        assert.equal("INITIATOR", sohMessage.fields[4].value);
    });

    test('Parse Message Selects Most Frequent Delimiter From List', () => {
        const text = "8=FIX.4.4|9=85|35=5|49=ACCEPTOR|56=INITIATOR|34=1|52=20190816-10:34:27.742|58=A^B^C|10=012|";
        const message = parseMessage(text, null, ["^", "|"]);
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(9, message.fields.length);
        assert.equal("A^B^C", message.fields[7].value);
    });

    test('Parse Message Wtih Wrong Field Delimiter', () => {
        const text = "8=FIX.4.4|9=72|35=A|49=ACCEPTOR|56=INITIATOR|34=1|52=20190816-10:34:27.742|98=0|108=30|10=012|";
        const message = parseMessage(text);
        assert.equal(undefined, message);
    });

    test('Parse FIXT.1.1 Message', () => {
        const text = "8=FIXT.1.19=7235=A49=ACCEPTOR56=INITIATOR34=152=20190816-10:34:27.74298=0108=3010=012";
        const message = parseMessage(text);
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(10, message.fields.length);
        assert.equal(8, message.fields[0].tag);
        assert.equal("INITIATOR", message.fields[4].value);
    });

    test('isAdministrative is true for Logon', () => {
        const text = "8=FIX.4.49=7235=A49=ACCEPTOR56=INITIATOR34=152=20190816-10:34:27.74298=0108=3010=012";
        const message = parseMessage(text);
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(true, message.isAdministrative());
    });

    test('isAdministrative is false for NewOrderSingle', () => {
        const text = "8=FIX.4.49=14035=D49=INITIATOR56=ACCEPTOR34=228252=20190929-04:51:00.84911=5070=49100=AUTO55=WTF54=160=20190929-04:35:33.56238=1000040=159=110=129";
        const message = parseMessage(text);
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(false, message.isAdministrative());
    });

    test('Parse message with a data field', () => {
        const text = "8=FIX.4.49=16735=D49=INITIATOR56=ACCEPTOR34=275252=20200114-08:13:20.04111=6170=60100=AUTO55=BHP.AX54=160=20200114-08:12:59.39738=1000040=244=2059=193=2089=ABCDEFABCDEFABCDEF10=220";
        const message = parseMessage(text, orchestra);
        if (!message) {
            assert.fail("message failed to parse");
            return;
        }
        assert.equal(20, message.fields.length);
        const signature = message.fields[18];
        assert.equal('QUJDREVGAUFCQ0RFRkFCQwFERUY=', signature.value);
    });

    test('Parse pretty printed field without enumerated value', () => {
        const field = parsePrettyPrintedField("      BeginString    (8) FIX.4.4", orchestra, null);
        assert(field);
        assert.equal(8, field.tag);
        assert.equal("FIX.4.4", field.value);
    });

    test('Parse pretty printed field with a none enumerated value that looks like a pretty printed enumerated value', () => {
        const field = parsePrettyPrintedField("      BeginString    (8) 1 - Change", orchestra, null);
        assert(field);
        assert.equal(8, field.tag);
        assert.equal("1 - Change", field.value);
    });

    test('Parse pretty printed field with enumerated value that has a description', () => {
        const field = parsePrettyPrintedField("   MDUpdateAction  (279) 1 - Change", orchestra, null);
        assert(field);
        assert.equal(279, field.tag);
        assert.equal("1", field.value);
    });

    test('Parse pretty printed field with enumerated value that does not have a description', () => {
        const field = parsePrettyPrintedField("   MDUpdateAction  (279) 1", orchestra, null);
        assert(field);
        assert.equal(279, field.tag);
        assert.equal("1", field.value);
    });

});
