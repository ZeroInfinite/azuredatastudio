/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { QueryResultsInput, ResultsViewState } from 'sql/parts/query/common/queryResultsInput';
import { TabbedPanel, IPanelTab, IPanelView } from 'sql/base/browser/ui/panel/panel';
import { IQueryModelService } from '../execution/queryModel';
import QueryRunner from 'sql/parts/query/execution/queryRunner';
import { MessagePanel } from './messagePanel';
import { GridPanel } from './gridPanel';
import { ChartTab } from './charting/chartTab';
import { QueryPlanTab } from 'sql/parts/queryPlan/queryPlan';

import * as nls from 'vs/nls';
import { PanelViewlet } from 'vs/workbench/browser/parts/views/panelViewlet';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import * as DOM from 'vs/base/browser/dom';
import { once, anyEvent } from 'vs/base/common/event';
import { IDisposable, dispose, Disposable } from 'vs/base/common/lifecycle';

class ResultsView extends Disposable implements IPanelView {
	private panelViewlet: PanelViewlet;
	private gridPanel: GridPanel;
	private messagePanel: MessagePanel;
	private container = document.createElement('div');
	private currentDimension: DOM.Dimension;
	private needsGridResize = false;
	private _state: ResultsViewState;

	constructor(private instantiationService: IInstantiationService) {
		super();
		this.panelViewlet = this._register(this.instantiationService.createInstance(PanelViewlet, 'resultsView', { showHeaderInTitleWhenSingleView: false }));
		this.gridPanel = this._register(this.instantiationService.createInstance(GridPanel, { title: nls.localize('gridPanel', 'Results'), id: 'gridPanel' }));
		this.messagePanel = this._register(this.instantiationService.createInstance(MessagePanel, { title: nls.localize('messagePanel', 'Messages'), minimumBodySize: 0, id: 'messagePanel' }));
		this.gridPanel.render();
		this.messagePanel.render();
		this.panelViewlet.create(this.container).then(() => {
			this.gridPanel.setVisible(false);
			this.panelViewlet.addPanels([
				{ panel: this.messagePanel, size: this.messagePanel.minimumSize, index: 1 }
			]);
		});
		anyEvent(this.gridPanel.onDidChange, this.messagePanel.onDidChange)(e => {
			let size = this.gridPanel.maximumBodySize;
			if (size < 1 && this.gridPanel.isVisible()) {
				this.gridPanel.setVisible(false);
				this.panelViewlet.removePanels([this.gridPanel]);
				this.gridPanel.layout(0);
			} else if (size > 0 && !this.gridPanel.isVisible()) {
				this.gridPanel.setVisible(true);
				let panelSize: number;
				if (this.state && this.state.gridPanelSize) {
					panelSize = this.state.gridPanelSize;
				} else if (this.currentDimension) {
					panelSize = Math.round(this.currentDimension.height * .7);
				} else {
					panelSize = 200;
					this.needsGridResize = true;
				}
				this.panelViewlet.addPanels([{ panel: this.gridPanel, index: 0, size: panelSize }]);
			}
		});
		let resizeList = anyEvent(this.gridPanel.onDidChange, this.messagePanel.onDidChange)(() => {
			let panelSize: number;
			if (this.state && this.state.gridPanelSize) {
				panelSize = this.state.gridPanelSize;
			} else if (this.currentDimension) {
				panelSize = Math.round(this.currentDimension.height * .7);
			} else {
				panelSize = 200;
				this.needsGridResize = true;
			}
			if (this.state.messagePanelSize) {
				this.panelViewlet.resizePanel(this.gridPanel, this.state.messagePanelSize);
			}
			this.panelViewlet.resizePanel(this.gridPanel, panelSize);
		});
		// once the user changes the sash we should stop trying to resize the grid
		once(this.panelViewlet.onDidSashChange)(e => {
			this.needsGridResize = false;
			resizeList.dispose();
		});

		this.panelViewlet.onDidSashChange(e => {
			if (this.state) {
				if (this.gridPanel.isExpanded()) {
					this.state.gridPanelSize = this.panelViewlet.getPanelSize(this.gridPanel);
				}
				if (this.messagePanel.isExpanded()) {
					this.state.messagePanelSize = this.panelViewlet.getPanelSize(this.messagePanel);
				}
			}
		});
	}

	render(container: HTMLElement): void {
		container.appendChild(this.container);
	}

	layout(dimension: DOM.Dimension): void {
		this.panelViewlet.layout(dimension);
		// the grid won't be resize if the height has not changed so we need to do it manually
		if (this.currentDimension && dimension.height === this.currentDimension.height) {
			this.gridPanel.layout(dimension.height);
		}
		this.currentDimension = dimension;
		if (this.needsGridResize) {
			this.panelViewlet.resizePanel(this.gridPanel, this.state.gridPanelSize || Math.round(this.currentDimension.height * .7));
		}
	}

	public clear() {
		this.gridPanel.clear();
		this.messagePanel.clear();
	}

	remove(): void {
		this.container.remove();
	}

	public set queryRunner(runner: QueryRunner) {
		this.gridPanel.queryRunner = runner;
		this.messagePanel.queryRunner = runner;
	}

	public hideResultHeader() {
		this.gridPanel.headerVisible = false;
	}

	public set state(val: ResultsViewState) {
		this._state = val;
		this.gridPanel.state = val.gridPanelState;
		this.messagePanel.state = val.messagePanelState;
	}

	public get state(): ResultsViewState {
		return this._state;
	}
}

class ResultsTab implements IPanelTab {
	public readonly title = nls.localize('resultsTabTitle', 'Results');
	public readonly identifier = 'resultsTab';
	public readonly view: ResultsView;

	constructor(instantiationService: IInstantiationService) {
		this.view = new ResultsView(instantiationService);
	}

	public set queryRunner(runner: QueryRunner) {
		this.view.queryRunner = runner;
	}

	public dispose() {
		dispose(this.view);
	}

	public clear() {
		this.view.clear();
	}
}

export class QueryResultsView extends Disposable {
	private _panelView: TabbedPanel;
	private _input: QueryResultsInput;
	private resultsTab: ResultsTab;
	private chartTab: ChartTab;
	private qpTab: QueryPlanTab;
	private _state: ResultsViewState;

	private runnerDisposables: IDisposable[];

	constructor(
		container: HTMLElement,
		@IInstantiationService instantiationService: IInstantiationService,
		@IQueryModelService private queryModelService: IQueryModelService
	) {
		super();
		this.resultsTab = this._register(new ResultsTab(instantiationService));
		this.chartTab = this._register(new ChartTab(instantiationService));
		this._panelView = this._register(new TabbedPanel(container, { showHeaderWhenSingleView: false }));
		this.qpTab = this._register(new QueryPlanTab());
		this._panelView.pushTab(this.resultsTab);
		this._register(this._panelView.onTabChange(e => {
			if (this.state) {
				this.state.activeTab = e;
			}
		}));
	}

	public style() {
	}

	public get state(): ResultsViewState {
		return this._state;
	}

	public setState(state: ResultsViewState) {
		this._state = state;
		this.resultsTab.view.state = state;
		this.qpTab.view.state = state.queryPlanState;
		this.chartTab.view.state = state.chartState;
	}

	public set input(input: QueryResultsInput) {
		this._input = input;
		dispose(this.runnerDisposables);
		this.runnerDisposables = [];
		let queryRunner = this.queryModelService._getQueryInfo(input.uri).queryRunner;
		this.resultsTab.queryRunner = queryRunner;
		this.chartTab.queryRunner = queryRunner;
		this.runnerDisposables.push(queryRunner.onQueryStart(e => {
			this.hideChart();
			this.hidePlan();
			this.state.visibleTabs = new Set();
			this.state.activeTab = this.resultsTab.identifier;
		}));
		if (this.state.visibleTabs.has(this.chartTab.identifier)) {
			if (!this._panelView.contains(this.chartTab)) {
				this._panelView.pushTab(this.chartTab);
			}
		}
		if (this.state.visibleTabs.has(this.qpTab.identifier)) {
			if (!this._panelView.contains(this.qpTab)) {
				this._panelView.pushTab(this.qpTab);
			}
		}
		this.runnerDisposables.push(queryRunner.onQueryEnd(() => {
			if (queryRunner.isQueryPlan) {
				queryRunner.planXml.then(e => {
					this.showPlan(e);
				});
			}
		}));
		if (this.state.activeTab) {
			this._panelView.showTab(this.state.activeTab);
		}
	}

	clearInput() {
		this._input = undefined;
		this.resultsTab.clear();
		this.qpTab.clear();
		this.chartTab.clear();
	}

	public dispose() {
		this._panelView.dispose();
	}

	public get input(): QueryResultsInput {
		return this._input;
	}

	public layout(dimension: DOM.Dimension) {
		this._panelView.layout(dimension);
	}

	public chartData(dataId: { resultId: number, batchId: number }): void {
		this.state.visibleTabs.add(this.chartTab.identifier);
		if (!this._panelView.contains(this.chartTab)) {
			this._panelView.pushTab(this.chartTab);
		}

		this._panelView.showTab(this.chartTab.identifier);
		this.chartTab.chart(dataId);
	}

	public hideChart() {
		if (this._panelView.contains(this.chartTab)) {
			this._panelView.removeTab(this.chartTab.identifier);
		}
	}

	public showPlan(xml: string) {
		this.state.visibleTabs.add(this.qpTab.identifier);
		if (!this._panelView.contains(this.qpTab)) {
			this._panelView.pushTab(this.qpTab);
		}

		this._panelView.showTab(this.qpTab.identifier);
		this.qpTab.view.showPlan(xml);
	}

	public hidePlan() {
		if (this._panelView.contains(this.qpTab)) {
			this._panelView.removeTab(this.qpTab.identifier);
		}
	}
}
