/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { TreeDataProvider, TreeItem, EventEmitter, Event, ProviderResult } from 'vscode';
import { localize } from './utilities';
import { join, dirname, basename } from 'path';

//---- loaded script explorer

export class LoadedScriptsProvider implements TreeDataProvider<ScriptTreeItem> {

	private _context: vscode.ExtensionContext;
	private _root: RootTreeItem;

	private _onDidChangeTreeData: EventEmitter<ScriptTreeItem> = new EventEmitter<ScriptTreeItem>();
	readonly onDidChangeTreeData: Event<ScriptTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
	}

	refresh(session: vscode.DebugSession) {
		if (!this._root) {
			this._root = this.createRoot();
		}
		this._root.add(session);
		this._onDidChangeTreeData.fire(undefined);
	}

	getChildren(node?: ScriptTreeItem): ProviderResult<ScriptTreeItem[]> {
		if (node === undefined) {	// return root node
			if (!this._root) {
				this._root = this.createRoot();
			}
			node = this._root;
		}
		return node.getChildren();
	}

	getTreeItem(node: ScriptTreeItem): TreeItem {
		return node;
	}

	private createRoot(): RootTreeItem {

		const root = new RootTreeItem();

		this._context.subscriptions.push(vscode.debug.onDidChangeActiveDebugSession(session => {
			if (session && (session.type === 'node' || session.type === 'node2')) {
				root.add(session);
				this._onDidChangeTreeData.fire(undefined);
			}
		}));

		this._context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent(event => {
			if (event.event === 'scriptLoaded' && (event.session.type === 'node' || event.session.type === 'node2')) {
				const sessionRoot = root.add(event.session);
				sessionRoot.addPath(event.body.path);
				this._onDidChangeTreeData.fire(undefined);
			}
		}));

		this._context.subscriptions.push(vscode.debug.onDidTerminateDebugSession(session => {
			root.remove(session);
			this._onDidChangeTreeData.fire(undefined);
		}));

		return root;
	}
}

class ScriptTreeItem extends TreeItem {

	_children: { [key: string]: ScriptTreeItem; };

	constructor(label: string, state: vscode.TreeItemCollapsibleState) {
		super(label ? label : '/', state);
		this._children = {};
	}

	setPath(session: vscode.DebugSession, path: string): void {
		this.command = {
			command: 'extension.node-debug.openScript',
			arguments: [ session, path ],
			title: ''
		};
	}

	getChildren(): ProviderResult<ScriptTreeItem[]> {
		const array = Object.keys(this._children).map( key => this._children[key] );
		return array.sort((a, b) => this.compare(a, b));
	}

	protected compare(a: ScriptTreeItem, b: ScriptTreeItem): number {
		return a.label.localeCompare(b.label);
	}
}

class FolderItem extends ScriptTreeItem {

	folder: vscode.Uri;

	constructor(label: string, state: vscode.TreeItemCollapsibleState, uri: vscode.Uri) {
		super(label, state);
		this.folder = uri;
	}
}

class RootTreeItem extends ScriptTreeItem {

	private _showedMoreThanOne: boolean;

	constructor() {
		super('Root', vscode.TreeItemCollapsibleState.Expanded);
		this._showedMoreThanOne = false;
	}

	getChildren(): ProviderResult<ScriptTreeItem[]> {
		const ids = Object.keys(this._children);
		if (!this._showedMoreThanOne && ids.length === 1) {
			return this._children[ids[0]].getChildren();
		}
		if (ids.length > 1) {
			this._showedMoreThanOne = true;
		}
		return super.getChildren();
	}

	find(session: vscode.DebugSession) {
		return <SessionTreeItem> this._children[session.id];
	}

	add(session: vscode.DebugSession): SessionTreeItem {
		let child = this.find(session);
		if (!child) {
			child = new SessionTreeItem(session);
			this._children[session.id] = child;
		}
		return child;
	}

	remove(session: vscode.DebugSession): void {
		delete this._children[session.id];
	}
}

class SessionTreeItem extends ScriptTreeItem {

	private _session: vscode.DebugSession;
	private _initialized: boolean;

	constructor(session: vscode.DebugSession) {
		super(session.name, vscode.TreeItemCollapsibleState.Expanded);
		this._initialized = false;
		this._session = session;
		const dir = dirname(__filename);
		this.iconPath = {
			light: join(dir, '..', '..', '..', 'images', 'debug-light.svg'),
			dark: join(dir, '..', '..', '..', 'images', 'debug-dark.svg')
		};
	}

	getChildren(): ProviderResult<ScriptTreeItem[]> {

		if (!this._initialized) {
			this._initialized = true;
			return listLoadedScripts(this._session).then(scripts => {
				if (scripts) {
					scripts.forEach(path => this.addPath(path.description));
				}
				return super.getChildren();
			});
		}

		return super.getChildren();
	}

	protected compare(a: ScriptTreeItem, b: ScriptTreeItem): number {
		const acat = this.category(a);
		const bcat = this.category(b);
		if (acat != bcat) {
			return acat - bcat;
		}
		return super.compare(a, b);
	}

	/**
	 * Return an ordinal number for folders
	 */
	private category(item: ScriptTreeItem): number {

		// workspace scripts come at the beginning in "folder" order
		if (item instanceof FolderItem) {
			const folders = vscode.workspace.workspaceFolders;
			const x = folders.indexOf(item.folder);
			if (x >= 0) {
				return x;
			}
		}

		// <node_internals> come at the very end
		if (item.label === '<node_internals>') {
			return 1000;
		}

		// everything else in between
		return 999;
	}

	addPath(path: string): void {

		const fullPath = path;

		// map to root folders
		const folderUris = vscode.workspace.workspaceFolders || [];
		let found = folderUris.filter( uri => path.indexOf(uri.path) === 0);
		if (found.length > 0) {
			const folderPath = found[0].path;
			path = path.replace(folderPath, basename(folderPath));
		}

		let x: ScriptTreeItem = this;
		path.split('/').forEach(segment => {
			let initialExpandState = segment === '<node_internals>' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded;
			if (!x._children[segment]) {
				if (found && found.length > 0) {
					x._children[segment] = new FolderItem(segment, initialExpandState, found[0]);
					found = undefined;
				} else {
					x._children[segment] = new ScriptTreeItem(segment, initialExpandState);
				}
			}
			x = x._children[segment];
		});
		x.setPath(this._session, fullPath);
		x.collapsibleState = vscode.TreeItemCollapsibleState.None;
	}
}

//---- loaded script picker

interface ScriptItem extends vscode.QuickPickItem {
	source?: any;	// Source
}

export function pickLoadedScript() {

	const session = vscode.debug.activeDebugSession;

	return listLoadedScripts(session).then(items => {

		let options : vscode.QuickPickOptions = {
			placeHolder: localize('select.script', "Select a script"),
			matchOnDescription: true,
			matchOnDetail: true,
			ignoreFocusOut: true
		};

		if (items === undefined) {
			items = [ { label: localize('no.loaded.scripts', "No loaded scripts available"), description: '' } ];
		}

		vscode.window.showQuickPick(items, options).then(item => {
			if (item && item.source) {
				openScript(session, item.source.path);
			}
		});
	});
}

function listLoadedScripts(session: vscode.DebugSession | undefined) : Thenable<ScriptItem[] | undefined> {

	if (session) {
		return session.customRequest('getLoadedScripts').then(reply => {
			return reply.loadedScripts;
		}, err => {
			return undefined;
		});
	} else {
		return Promise.resolve(undefined);
	}
}

export function openScript(session: vscode.DebugSession, path: string) {
	let uri = vscode.Uri.parse(`debug:${path}?session=${session.id}`);
	vscode.workspace.openTextDocument(uri).then(doc => vscode.window.showTextDocument(doc));
}
