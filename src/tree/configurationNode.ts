/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Red Hat. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { ConfigurationItem } from './configurationItem';
import { EventEmitter, TreeItemCollapsibleState, Uri, workspace } from 'vscode';
import { AbstractNode, ITreeNode } from './abstractNode';
import { ClassificationNode } from './classificationNode';
import { DataProvider } from './dataProvider';
import * as path from 'path';
import { HintNode } from './hintNode';
import { RhamtConfiguration, ChangeType, IClassification, IHint, ReportHolder, IIssue, IssueContainer } from '../model/model';
import { ModelService } from '../model/modelService';
import { FileNode } from './fileNode';
import { FolderNode } from './folderNode';
import { HintsNode } from './hintsNode';
import { ClassificationsNode } from './classificationsNode';
import { SortUtil } from './sortUtil';
import { ResultsNode } from './resultsNode';

export interface Grouping {
    groupByFile: boolean;
    groupBySeverity: boolean;
}

export class ConfigurationNode extends AbstractNode<ConfigurationItem> implements ReportHolder {

    private grouping: Grouping;
    private classifications: IClassification[] = [];
    private hints: IHint[] = [];
    private issueFiles = new Map<string, IIssue[]>();
    private issueNodes = new Map<IIssue, ITreeNode>();
    private resourceNodes = new Map<string, ITreeNode>();
    private childNodes = new Map<string, ITreeNode>();

    private results = [];

    constructor(
        config: RhamtConfiguration,
        grouping: Grouping,
        modelService: ModelService,
        onNodeCreateEmitter: EventEmitter<ITreeNode>,
        dataProvider: DataProvider) {
        super(config, modelService, onNodeCreateEmitter, dataProvider);
        this.grouping = grouping;
        this.treeItem = this.createItem();
        this.listen();
    }

    createItem(): ConfigurationItem {
        return new ConfigurationItem(this.config);
    }

    delete(): Promise<void> {
        return Promise.resolve();
    }

    public getChildren(): Promise<any> {
        return Promise.resolve(this.results);
    }

    public hasMoreChildren(): boolean {
        return this.results.length > 0;
    }

    private listen(): void {
        this.reload();
        this.config.onChanged.on(change => {
            if (change.type === ChangeType.MODIFIED &&
                change.name === 'name') {
                this.refresh(this);
            }
        });
        this.config.onResultsLoaded.on(() => {
            this.reload();
        });
    }

    private reload(): void {
        const base = [__dirname, '..', '..', '..', 'resources'];
        this.treeItem.iconPath = {
            light: path.join(...base, 'light', 'Loading.svg'),
            dark: path.join(...base, 'dark', 'Loading.svg')
        };
        if (!this.config.results) {
            this.results = [];
            this.treeItem.collapsibleState = TreeItemCollapsibleState.None;
            super.refresh(this);
            setTimeout(() => {
                this.treeItem.iconPath = process.env.CHE_WORKSPACE_NAMESPACE ? 
                    'config-icon medium-purple file-icon' : undefined;
                super.refresh(this);
            }, 2000);
            return;
        }
        else {
            this.treeItem.collapsibleState = TreeItemCollapsibleState.Expanded;
            this.results = [
                new ResultsNode(
                    this.config,
                    this.modelService,
                    this.onNodeCreateEmitter,
                    this.dataProvider,
                    this)
            ];
            this.computeIssues();
            super.refresh(this);
            this.dataProvider.reveal(this, true);
            setTimeout(() => {
                this.treeItem.iconPath = undefined;
                this.refresh(this);
            }, 2000);
        }
    }

    private clearModel(): void {
        this.classifications = [];
        this.hints = [];
        this.issueFiles.clear();
        this.issueNodes.clear();
        this.resourceNodes.clear();
        this.childNodes.clear();
    }

    private computeIssues(): void {
        this.clearModel();
        if (this.config.results) {
            this.config.results.getClassifications().forEach(classification => {
                const root = workspace.getWorkspaceFolder(Uri.file(classification.file));
                if (!root) return;
                this.classifications.push(classification);
                this.initIssue(classification, this.createClassificationNode(classification));
            });
            this.config.results.getHints().forEach(hint => {
                const root = workspace.getWorkspaceFolder(Uri.file(hint.file));
                if (!root) return;
                this.hints.push(hint);
                this.initIssue(hint, this.createHintNode(hint));
            });
        }
    }

    private initIssue(issue: IIssue, node: ITreeNode): void {
        let nodes = this.issueFiles.get(issue.file);
        if (!nodes) {
            nodes = [];
            this.issueFiles.set(issue.file, nodes);
        }
        nodes.push(issue);
        this.issueNodes.set(issue, node);
        this.buildResourceNodes(issue.file);
    }

    private buildResourceNodes(file: string): void {

        const root = workspace.getWorkspaceFolder(Uri.file(file));

        if (!this.resourceNodes.has(file)) {
            this.resourceNodes.set(file, new FileNode(
                this.config,
                file,
                this.modelService,
                this.onNodeCreateEmitter,
                this.dataProvider,
                this));

            if (!this.childNodes.has(root.uri.fsPath)) {
                const folder = new FolderNode(
                    this.config,
                    root.uri.fsPath,
                    this.modelService,
                    this.onNodeCreateEmitter,
                    this.dataProvider,
                    this);
                this.childNodes.set(root.uri.fsPath, folder);
                this.resourceNodes.set(root.uri.fsPath, folder);
            }

            const getParent = location => path.resolve(location, '..');
            let parent = getParent(file);

            while (parent) {
                if (this.resourceNodes.has(parent)) {
                    break;
                }
                this.resourceNodes.set(parent, new FolderNode(
                    this.config,
                    parent,
                    this.modelService,
                    this.onNodeCreateEmitter,
                    this.dataProvider,
                    this));
                parent = getParent(parent);
            }
        }
    }

    getChildNodes(node: ITreeNode): ITreeNode[] {
        let children = [];
        if (node instanceof ResultsNode) {
            if (this.grouping.groupByFile) {
                const children = Array.from(this.childNodes.values());
                return children.sort(SortUtil.sort);
            }
            return Array.from(this.issueNodes.values());
        }
        if (node instanceof FileNode) {
            const issues = this.issueFiles.get((node as FileNode).file);
            if (issues) {
                issues.forEach(issue => children.push(this.issueNodes.get(issue)));
            }
        }
        else if (node instanceof HintsNode) {
            const file = (node as HintsNode).file;
            children = this.hints.filter(issue => issue.file === file)
                .map(hint => this.issueNodes.get(hint));
        }
        else if (node instanceof ClassificationsNode) {
            const file = (node as ClassificationsNode).file;
            children = this.classifications.filter(issue => issue.file === file)
                .map(classification => this.issueNodes.get(classification));
        }
        else {
            const segments = this.getChildSegments((node as FolderNode).folder);
            segments.forEach(segment => children.push(this.resourceNodes.get(segment)));
        }
        return children;
    }

    private getChildSegments(segment: string): string[] {
        const children = [];
        this.resourceNodes.forEach((value, key) => {
            if (key !== segment && key.includes(segment)) {
                if (path.resolve(key, '..') === segment) {
                    children.push(key);
                }
            }
        });
        return children;
    }

    protected refresh(node?: ITreeNode): void {
        this.treeItem.refresh();
        super.refresh(node);
    }

    createClassificationNode(classification: IClassification): ITreeNode {
        const node: ITreeNode = new ClassificationNode(
            classification,
            this.config,
            this.modelService,
            this.onNodeCreateEmitter,
            this.dataProvider);
        node.root = this;
        this.onNodeCreateEmitter.fire(node);
        return node;
    }

    createHintNode(hint: IHint): ITreeNode {
        const node: ITreeNode = new HintNode(
            hint,
            this.config,
            this.modelService,
            this.onNodeCreateEmitter,
            this.dataProvider);
        node.root = this;
        this.onNodeCreateEmitter.fire(node);
        return node;
    }

    getReport(): string {
        return this.config.getReport();
    }

    deleteIssue(node: any): void {
        const issue = (node as IssueContainer).getIssue();
        this.config.deleteIssue(issue);
        this.issueNodes.delete(issue);
        const file = issue.file;
        const nodes = this.issueFiles.get(file);
        if (nodes) {
            const index = nodes.indexOf(issue);
            if (index > -1) {
                nodes.splice(index, 1);
            }
            if (nodes.length === 0) {
                this.resourceNodes.delete(file);
                let parentToRefresh = undefined;
                const getParentFolderPath = location => path.resolve(location, '..');
                let parentFolderPath = getParentFolderPath(file);
                while (parentFolderPath) {
                    const parentFolder = this.resourceNodes.get(parentFolderPath) as any;
                    if (!parentFolder) break;
                    const children = this.getChildSegments(parentFolderPath);
                    if (children.length > 0) {
                        parentToRefresh = parentFolder;
                        break;
                    }
                    this.resourceNodes.delete(parentFolderPath);
                    const root = workspace.getWorkspaceFolder(Uri.file(parentFolderPath));
                    if (parentFolderPath === root.uri.fsPath && this.childNodes.has(parentFolderPath)) {
                        this.childNodes.delete(parentFolderPath);
                        parentToRefresh = parentFolder.parentNode;
                        break;
                    }
                    parentFolderPath = getParentFolderPath(parentFolderPath);
                }
                if (parentToRefresh) {
                    parentToRefresh.refresh(parentToRefresh);
                }
            }
            else {
                node.parentNode.refresh(node.parentNode);
            }
        }
    }

    markIssueAsComplete(node: any): void {
        const issue = (node as IssueContainer).getIssue();
        this.config.markIssueAsComplete(issue);
    }
}
