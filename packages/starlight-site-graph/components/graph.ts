import * as d3 from 'd3';
import {Application, Graphics, Text, Ticker} from 'pixi.js';
import config from "virtual:starlight-site-graph/config";
import type {GraphConfig} from "../config";

import {type AnimationConfig, Animator} from "./animator";

import {showContextMenu} from "./context-menu";
import {
    addToVisitedEndpoints,
    getRelativePath,
    getVisitedEndpoints,
    onClickOutside,
    simplifySlug,
    stripSlashes
} from "./util";
import type {AnimatedValues, ContentDetails, LinkData, NodeData} from "./types";

import {LABEL_OFFSET, NODE_SIZE, NODE_SIZE_MODIFIER} from "./constants";
import {animatables} from "./animatables";
import {icons} from "./icons";


const MAX_DEPTH = 6;


export class GraphComponent extends HTMLElement {
    graphContainer: HTMLElement;
    mockGraphContainer: HTMLElement;
    actionContainer: HTMLElement;
    blurContainer: HTMLElement;

    app!: Application;
    simulation!: d3.Simulation<NodeData, undefined>;
    zoom: d3.ZoomTransform;

    links!: Graphics;

    config!: GraphConfig;
    processedData!: ReturnType<typeof this.processSitemapData>;
    animator: Animator<ReturnType<typeof animatables>>;

    currentlyHovered: string = "";
    isFullscreen: boolean = false;
    fullscreenExitHandler?: () => void;

    currentPage: string = stripSlashes(location.pathname);

    visitedPages: Set<string> = getVisitedEndpoints();

    constructor() {
        super();

        this.config = config.graphConfig;
        this.config.depth = Math.min(this.config.depth, 5);


        this.zoom = d3.zoomIdentity;

        this.classList.add('graph-component');

        this.graphContainer = document.createElement('div');
        this.graphContainer.classList.add('graph-container');
        this.graphContainer.onkeyup = (e) => {
            if (e.key === "f") this.enableFullscreen()
        }
        this.graphContainer.tabIndex = 0;
        this.appendChild(this.graphContainer);

        this.actionContainer = document.createElement('div');
        this.actionContainer.classList.add('graph-action-container');
        this.renderActionContainer();
        this.graphContainer.appendChild(this.actionContainer);

        this.mockGraphContainer = document.createElement('div');
        this.mockGraphContainer.classList.add('graph-container');

        this.blurContainer = document.createElement('div');
        this.blurContainer.classList.add('background-blur');

        this.animator = new Animator<ReturnType<typeof animatables>>(animatables(config.graphConfig));

        this.mountGraph().then(() => {
            this.setup()
        });
    }

    override remove() {
        this.app.destroy();
        this.graphContainer.remove();
        this.mockGraphContainer.remove();
        this.blurContainer.remove();

        super.remove();
    }

    enableFullscreen() {
        if (this.isFullscreen) return;

        this.isFullscreen = true;
        this.graphContainer.classList.toggle('is-fullscreen', true);
        this.appendChild(this.mockGraphContainer);
        this.appendChild(this.blurContainer);
        this.fullscreenExitHandler = onClickOutside(this.graphContainer, () => {
            this.disableFullscreen()
        });
        this.graphContainer.onkeyup = (e) => {
            if (e.key === "Escape" || e.key === "f") this.disableFullscreen()
        }
        this.renderActionContainer();

        this.app.renderer.resize(this.graphContainer.clientWidth, this.graphContainer.clientHeight);
    }

    disableFullscreen() {
        if (!this.isFullscreen) return;

        this.isFullscreen = false;
        this.graphContainer.classList.toggle('is-fullscreen', false);
        this.removeChild(this.mockGraphContainer);
        this.removeChild(this.blurContainer);
        this.fullscreenExitHandler!();
        this.graphContainer.onkeyup = (e) => {
            if (e.key === "f") this.enableFullscreen()
        }
        this.renderActionContainer();

        this.app.renderer.resize(this.graphContainer.clientWidth, this.graphContainer.clientHeight);
    }

    renderActionContainer() {
        this.actionContainer.replaceChildren();
        for (const action of ["fullscreen", "depth"]) {
            const actionElement = document.createElement('button');
            actionElement.classList.add('graph-action-button');
            this.actionContainer.appendChild(actionElement);

            if (action === "fullscreen") {
                actionElement.innerHTML = this.isFullscreen ? icons.minimize : icons.maximize;
                actionElement.onclick = (e) => {
                    (this.isFullscreen ? this.disableFullscreen() : this.enableFullscreen());
                    e.stopPropagation()
                }
                actionElement.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showContextMenu(e, [
                        {text: "Minimize", icon: icons.minimize, onClick: () => this.disableFullscreen()},
                        {text: "Maximize", icon: icons.maximize, onClick: () => this.enableFullscreen()},
                    ]);
                }
            } else if (action === "depth") {
                actionElement.innerHTML = icons["graph" + this.config.depth as keyof typeof icons];
                actionElement.onclick = () => {
                    this.config.depth = (this.config.depth + 1) % MAX_DEPTH;
                    this.setup();
                    this.renderActionContainer()
                }
                actionElement.oncontextmenu = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showContextMenu(e,
                        Array.from({length: MAX_DEPTH}, (_, i) => ({
                            text: i === MAX_DEPTH - 1 ?
                                "Show Entire Graph" :
                                i === 0 ?
                                    "Show Only Current" :
                                    i === 1 ?
                                        "Show Adjacent" :
                                        `Show Distance ${i}`,
                            icon: icons["graph" + i as keyof typeof icons],
                            onClick: () => {
                                if (this.config.depth !== i) {
                                    this.config.depth = i;
                                    this.setup();
                                    this.renderActionContainer();
                                }
                            }
                        }))
                    );
                }
            }
        }
    }

    async mountGraph() {
        this.app = new Application();
        await this.app.init({
            antialias: true,
            backgroundAlpha: 0,
            resolution: 4,
            resizeTo: this.graphContainer,
        });
        this.graphContainer.appendChild(this.app.canvas);

        this.links = new Graphics();
        this.app.stage.sortableChildren = true;
        this.app.stage.addChild(this.links);
        this.app.ticker.add((ticker) => {
            this.tick(ticker)
        });
    }

    processSitemapData(siteData: Record<string, ContentDetails>): { nodes: NodeData[], links: LinkData[] } {
        let slug = location.pathname;
        const links: LinkData[] = []
        const tags: string[] = []
        const data: Map<string, ContentDetails> = new Map(
            Object.entries<ContentDetails>(siteData).map(([k, v]) => [
                simplifySlug(k),
                v,
            ]),
        )

        let depth = this.config.depth;
        if (depth >= 5)
            depth = -1;

        if (slug.startsWith("/"))
            slug = slug.slice(1)
        if (slug.endsWith("/"))
            slug = slug.slice(0, -1)

        const validLinks = new Set(data.keys())
        for (const [source, details] of data.entries()) {
            const outgoing = details.links ?? [];
            for (const dest of outgoing) {
                if (validLinks.has(dest)) {
                    links.push({source: source as unknown as NodeData, target: dest as unknown as NodeData})
                }
            }

            if (this.config.showTags) {
                const localTags = details.tags
                    .filter((tag) => !this.config.removeTags.includes(tag))
                    .map((tag) => simplifySlug(("tags/" + tag)))

                tags.push(...localTags.filter((tag) => !tags.includes(tag)))

                for (const tag of localTags) {
                    links.push({source: source as unknown as NodeData, target: tag as unknown as NodeData})
                }
            }
        }

        const neighbourhood = new Set<string>();
        // __SENTINEL is used to separate levels in the BFS
        const queue: (string | "__SENTINEL")[] = [slug, "__SENTINEL"];

        if (depth !== -1) {
            while (depth >= 0 && queue.length > 0) {
                const current = queue.shift()!;

                if (current === "__SENTINEL") {
                    depth -= 1;
                    if (queue.length === 0) {
                        break;
                    }
                    queue.push("__SENTINEL");
                } else if (neighbourhood.has(current)) {
                    continue;
                } else {
                    neighbourhood.add(current);
                    const outgoing = links.filter((l) => l.source as unknown as string === current);
                    const incoming = links.filter((l) => l.target as unknown as string === current);
                    queue.push(...outgoing.map((l) => l.target as unknown as string), ...incoming.map((l) => l.source as unknown as string));
                }
            }
        } else {
            validLinks.forEach((id) => neighbourhood.add(id))
            if (this.config.showTags) tags.forEach((tag) => neighbourhood.add(tag))
        }

        return {
            nodes: [...neighbourhood].map((url) => {
                return {
                    id: url,
                    text: url.startsWith("tags/") ? "#" + url.substring(5) : data.get(url)?.title ?? url,
                    tags: data.get(url)?.tags ?? [],
                    neighborCount: (data.get(url)?.links?.length ?? 0) + (data.get(url)?.backlinks?.length ?? 0),
                }
            }),
            links: links.filter((l) => neighbourhood.has(l.source as unknown as string) && neighbourhood.has(l.target as unknown as string)),
        }
    }


    simulationUpdate() {
        this.simulation
            .stop()
            .force(
                "link",
                d3.forceLink(this.processedData.links)
                    .id((d: any) => d.id)
                    .distance(250),
            )
            .force("charge", d3.forceManyBody().distanceMax(500).strength(-1000))
            .force("forceX", d3.forceX().strength(0.1))
            .force("forceY", d3.forceY().strength(0.1))
            .force("center", d3.forceCenter(0, 0))
            .force("collision", d3.forceCollide().radius(50))
            .restart();
    }

    resetStyle() {
        this.animator.startAnimationsTo({
            nodeColorHover: "default",
            nodeColor: "default",
            visitedNodeColorHover: "default",
            visitedNodeColor: "default",
            currentNodeColorHover: "default",
            currentNodeColor: "default",

            nodeOpacityHover: "default",
            nodeOpacity: "default",

            linkColorHover: "default",
            linkColor: "default",
            linkOpacityHover: "default",
            linkOpacity: "default",

            labelOpacityHover: "default",
            labelOpacity: "default",
            labelOffset: "default"
        });
        this.animator.startAnimation('labelOpacity', this.getCurrentLabelOpacity());
    }

    getCurrentLabelOpacity(k: number = this.zoom.k): number {
        return Math.max(((k * this.config.opacityScale) - 1) / 3.75, 0);
    }

    cleanup() {
        if (this.simulation) {
            this.app.stage.removeChildren();
            this.app.stage.addChild(this.links);
            this.links.clear();
            this.simulation.stop();
            this.simulation.nodes([]);
            this.simulation.force("link", null);
            this.currentlyHovered = "";
            this.zoom = d3.zoomIdentity;
        }
    }

    getColor(node: NodeData, hover: boolean): string {
        let color = "";
        if (node.id === this.currentPage) {
            color = 'currentNodeColor';
        } else if (this.visitedPages.has(node.id)) {
            color = 'visitedNodeColor';
        } else {
            color = 'nodeColor';
        }
        // @ts-ignore ts does not understand that the keys are valid
        return this.animator.getValue(color + (hover ? "Hover" : ""));
    }

    getNodeSize(node: NodeData): number {
        return NODE_SIZE + (node.neighborCount ?? 0) * NODE_SIZE_MODIFIER;
    }

    findOverlappingNode(x: number, y: number): NodeData | undefined {
        for (const node of this.simulation.nodes()) {
            if ((node.x! - x) ** 2 + (node.y! - y) ** 2 <= this.getNodeSize(node) ** 2) {
                return node;
            }
        }

        return undefined;
    }

    renderNodes() {
        for (const node of this.simulation.nodes()) {
            const nodeDot = new Graphics();
            nodeDot.zIndex = 0;
            nodeDot.circle(0, 0, this.getNodeSize(node))
                .fill(this.getColor(node, false));

            const nodeText = new Text({
                text: node.text || node.id,
                style: {
                    fill: 0xffffff,
                    fontSize: 12,
                },
                zIndex: 100,
            });
            nodeText.anchor.set(0.5, 0.5);
            nodeText.alpha = this.animator.getValue('labelOpacity');

            node.node = nodeDot;
            node.label = nodeText;
            this.app.stage.addChild(nodeText);
            this.app.stage.addChild(nodeDot);
        }
    }


    setup() {
        this.cleanup();

        this.processedData = this.processSitemapData(config.sitemap as Record<string, ContentDetails>);
        this.simulation = d3.forceSimulation<NodeData>(this.processedData.nodes);
        this.simulationUpdate();

        this.renderNodes();

        let dragX = 0;
        let dragY = 0;
        d3.select(this.app.canvas).call(
            (d3
                .drag()
                .container(this.app.canvas) as unknown as d3.DragBehavior<HTMLCanvasElement, unknown, unknown>)
                .subject(event => {
                    return this.simulation.find(...this.zoom.invert([event.x, event.y]), 10)
                })
                .on('start', (e) => {
                    if (!e.subject) return;

                    if (!e.active) this.simulation.alphaTarget(0.3).restart();
                    e.subject.fx = e.subject.x;
                    e.subject.fy = e.subject.y;
                    dragX = e.x;
                    dragY = e.y;
                })
                .on('drag', (e) => {
                    if (!e.subject) return;

                    dragX += e.dx / this.animator.getValue('zoom');
                    dragY += e.dy / this.animator.getValue('zoom');

                    e.subject.fx = dragX;
                    e.subject.fy = dragY;
                })
                .on('end', (e) => {
                    if (!e.subject) return;

                    if (!e.active) this.simulation.alphaTarget(0);
                    e.subject.fx = null;
                    e.subject.fy = null;
                }),
        );

        d3.select(this.app.canvas).on('mousemove', (e: MouseEvent) => {
            const [x, y] = this.zoom.invert([e.offsetX, e.offsetY]);
            const closestNode = this.findOverlappingNode(x, y);

            if (closestNode) {
                this.currentlyHovered = closestNode.id;
                this.animator.startAnimationsTo({
                    nodeColorHover: "hover",
                    nodeColor: "blur",
                    visitedNodeColorHover: "hover",
                    visitedNodeColor: "blur",
                    currentNodeColorHover: "hover",
                    currentNodeColor: "blur",

                    nodeOpacityHover: "hover",
                    nodeOpacity: "blur",

                    linkColorHover: "hover",
                    linkColor: "blur",
                    linkOpacityHover: "hover",
                    linkOpacity: "blur",

                    labelOpacityHover: "hover",
                    labelOpacity: "blur",
                    labelOffset: "hover"
                });
            } else if (this.currentlyHovered) {
                this.resetStyle();
                this.animator.setOnFinished("nodeColorHover", () => {
                    this.currentlyHovered = "";
                });
            }
        });

        d3.select(this.app.canvas).on('click', (e: MouseEvent) => {
            const closestNode = this.simulation.find(...this.zoom.invert([e.offsetX, e.offsetY]), 5);
            if (closestNode) {
                addToVisitedEndpoints(closestNode.id);
                window.location.assign(getRelativePath(this.currentPage, closestNode.id))
            }
        });


        d3.select(this.app.canvas as HTMLCanvasElement).call(
            (d3.zoom() as d3.ZoomBehavior<HTMLCanvasElement, unknown>)
                .scaleExtent([0.05, 4])
                .on('zoom', ({transform}: { transform: d3.ZoomTransform }) => {
                    this.zoom = transform;
                    this.animator.startAnimations({
                        zoom: transform.k,
                        zoomX: transform.x,
                        zoomY: transform.y,
                        labelOpacity: this.getCurrentLabelOpacity(transform.k),
                    });
                }),
        );
    }

    tick(ticker: Ticker) {
        this.animator.update(ticker.deltaMS);

        if (this.animator.isAnimating("zoom")) {
            this.app.stage.updateTransform({
                scaleX: this.animator.getValue('zoom'),
                scaleY: this.animator.getValue('zoom'),
                x: this.animator.getValue('zoomX'),
                y: this.animator.getValue('zoomY'),
            });
        }

        // FIXME: Disable redrawing when group "hover" is not animating
        for (const node of this.simulation.nodes()) {
            node.label!.scale.set(1);
            node.label!.alpha = this.animator.getValue('labelOpacity');

            if (this.currentlyHovered && node.id === this.currentlyHovered) {
                    node.node!.zIndex = 100;
                    node.label!.position.set(node.x!, node.y! + this.animator.getValue('labelOffset'));
                    node.label!.alpha = this.animator.getValue('labelOpacityHover');

                    (node.node!)
                        .clear()
                        .circle(0, 0, this.getNodeSize(node))
                        .fill(this.getColor(node, true));
            } else {
                node.label!.position.set(node.x!, node.y! + LABEL_OFFSET);
                node.label!.alpha = this.animator.getValue('labelOpacity');
                node.node!.alpha = this.animator.getValue('nodeOpacity');
                node.node!.zIndex = 1;
                (node.node!)
                    .clear()
                    .circle(0, 0, this.getNodeSize(node))
                    .fill(this.getColor(node, false));
            }

            node.node!.position.set(node.x!, node.y!);
        }

        this.links.clear();

        for (const link of this.processedData.links) {
            let isAdjacent = this.currentlyHovered && (link.source.id === this.currentlyHovered || link.target.id === this.currentlyHovered);
            this.links
                .moveTo(link.source.x!, link.source.y!)
                .lineTo(link.target.x!, link.target.y!)
                .fill()
                .stroke({
                    color: isAdjacent ? this.animator.getValue('linkColorHover') : this.animator.getValue('linkColor'),
                    width: 1 / this.animator.getValue('zoom'),
                    alpha: (isAdjacent ? this.animator.getValue('linkOpacityHover') : this.animator.getValue('linkOpacity'))
                });

            // TODO: Add properly
            if (this.config.renderArrows) {
                const arrowHead = new Graphics();
                arrowHead
                    .lineTo(-5, 5)
                    .lineTo(5, 5)
                    .lineTo(0, 0)
                    .closePath()
                    .fill(isAdjacent ? this.animator.getValue('linkColorHover') : this.animator.getValue('linkColor'))
                    .position.set(link.target.x!, link.target.y!)
                this.links.addChild(arrowHead);
                link.target.arrowHead = arrowHead;
            }
        }
    }

}

customElements.define('graph-component', GraphComponent);
