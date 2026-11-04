import Handlebars from 'handlebars';

// Handlebars' bundled typings only describe part of its AST (a MustacheStatement
// has no path or params, and Handlebars.AST only exposes `helpers`), so the
// handful of node shapes this file reads are declared here
interface PathNode {
    type: 'PathExpression';
    original: string;
    parts: string[];
    data: boolean;
    depth: number;
}

interface LiteralNode {
    type: 'StringLiteral' | 'NumberLiteral' | 'BooleanLiteral';
    value: string | number | boolean;
}

interface EmptyLiteralNode {
    type: 'NullLiteral' | 'UndefinedLiteral';
}

interface CallNode {
    type: 'MustacheStatement' | 'SubExpression';
    path: ExpressionNode;
    params: ExpressionNode[];
}

interface ContentNode {
    type: 'ContentStatement';
    value: string;
}

type ExpressionNode = PathNode | LiteralNode | EmptyLiteralNode | CallNode | { type: string };
type StatementNode = ContentNode | CallNode | { type: string };

/**
 * Render a Basemap `title` template against a feature's properties without
 * ever compiling it to JavaScript.
 *
 * `Handlebars.compile()` builds its template function with `new Function()`,
 * which the Content-Security-Policy served by nginx blocks (no 'unsafe-eval').
 * Handlebars.parse() only builds an AST, so it is safe under that policy - the
 * AST is walked here instead.
 *
 * Supports what the server-side renderer (api/common/handlebars.ts) offers for
 * titles: property paths ({{a}}, {{a.b}}, {{this.a}}), string/number/boolean
 * literals and the `fallback`, `slice` and `htmlstrip` helpers, including
 * nested sub-expressions. Block helpers, partials, decorators and unknown
 * helpers are not supported.
 *
 * Unlike Handlebars' own output the result is plain text, so values are not
 * HTML-escaped: titles are rendered as text, and escaping would show `&amp;`.
 *
 * @returns the trimmed title, or null if the template is empty, can't be
 *          parsed, uses an unsupported construct, or renders to nothing
 */
export function renderTitleTemplate(template: string, properties: Record<string, unknown>): string | null {
    let source = template.trim();
    if (!source.length) return null;

    // Bare property name (e.g. "callsign") => wrap as a handlebars expression
    if (/^[a-zA-Z0-9_]+$/.test(source)) {
        source = `{{${source}}}`;
    }

    try {
        const program = Handlebars.parse(source);
        let out = '';

        for (const statement of program.body as unknown as StatementNode[]) {
            if (statement.type === 'ContentStatement') {
                out += (statement as ContentNode).value;
            } else if (statement.type === 'MustacheStatement') {
                out += stringify(evaluate(statement as CallNode, properties));
            } else if (statement.type !== 'CommentStatement') {
                // Blocks, partials and decorators
                return null;
            }
        }

        return out.trim() || null;
    } catch {
        return null;
    }
}

type Helper = (...args: unknown[]) => unknown;

const helpers: Record<string, Helper> = {
    fallback: (...args) => args.find((arg) => !!arg),
    slice: (text, start, end) => {
        if (typeof text !== 'string' || start === undefined || isNaN(Number(start))) return '';
        if (end !== undefined && !isNaN(Number(end))) return text.substring(Number(start), Number(end));
        return text.substring(Number(start));
    },
    htmlstrip: (text) => {
        if (typeof text !== 'string') return '';
        return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }
};

function evaluate(node: CallNode, properties: Record<string, unknown>): unknown {
    if (node.path.type !== 'PathExpression') throw new Error('Unsupported expression');

    const path = node.path as PathNode;
    const name = path.original;
    const helper = helpers[name];

    // Anything that takes arguments must be a helper we know about
    if (node.params.length) {
        if (!helper) throw new Error(`Unsupported helper: ${name}`);
        return helper(...node.params.map((param) => value(param, properties)));
    }

    return helper ? helper() : lookup(path, properties);
}

function value(node: ExpressionNode, properties: Record<string, unknown>): unknown {
    switch (node.type) {
        case 'PathExpression':
            return lookup(node as PathNode, properties);
        case 'SubExpression':
            return evaluate(node as CallNode, properties);
        case 'StringLiteral':
        case 'NumberLiteral':
        case 'BooleanLiteral':
            return (node as LiteralNode).value;
        case 'NullLiteral':
        case 'UndefinedLiteral':
            return undefined;
        default:
            throw new Error(`Unsupported expression: ${node.type}`);
    }
}

function lookup(path: PathNode, properties: Record<string, unknown>): unknown {
    // @data variables and parent scopes (../x) have no meaning here
    if (path.data || path.depth > 0) throw new Error('Unsupported path');

    let current: unknown = properties;
    for (const part of path.parts) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[String(part)];
    }

    return current;
}

function stringify(input: unknown): string {
    if (typeof input === 'string') return input;
    if (typeof input === 'number' || typeof input === 'boolean') return String(input);
    return '';
}
