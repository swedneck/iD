import _clone from 'lodash-es/clone';
import _values from 'lodash-es/values';

import { select as d3_select } from 'd3-selection';

import { dataFeatureIcons } from '../../data';
import { osmEntity } from '../osm';
import { svgPointTransform } from './index';


var TAU = 2 * Math.PI;
function ktoz(k) { return Math.log(k * TAU) / Math.LN2 - 8; }


export function svgVertices(projection, context) {
    var radiuses = {
        //       z16-, z17,   z18+,  tagged
        shadow: [6,    7.5,   7.5,   11.5],
        stroke: [2.5,  3.5,   3.5,   7],
        fill:   [1,    1.5,   1.5,   1.5]
    };

    var _hover;


    function draw(selection, vertices, klass, graph, siblings, filter) {
        siblings = siblings || {};
        var icons = {};
        var directions = {};
        var wireframe = context.surface().classed('fill-wireframe');
        var zoom = ktoz(projection.scale());
        var z = (zoom < 17 ? 0 : zoom < 18 ? 1 : 2);


        function getIcon(entity) {
            if (entity.id in icons) return icons[entity.id];

            icons[entity.id] =
                entity.hasInterestingTags() &&
                context.presets().match(entity, graph).icon;
            return icons[entity.id];
        }


        // memoize directions results, return false for empty arrays (for use in filter)
        function getDirections(entity) {
            if (entity.id in directions) return directions[entity.id];

            var angles = entity.directions(graph, projection);
            directions[entity.id] = angles.length ? angles : false;
            return angles;
        }


        function setClass(klass) {
            return function(entity) {
                this.setAttribute('class', 'node vertex ' + klass + ' ' + entity.id);
            };
        }


        function updateAttributes(selection) {
            ['shadow','stroke','fill'].forEach(function(klass) {
                var rads = radiuses[klass];
                selection.selectAll('.' + klass)
                    .each(function(entity) {
                        var i = z && getIcon(entity);
                        var c = i ? 0.5 : 0;
                        var r = rads[i ? 3 : z];

                        // slightly increase the size of unconnected endpoints #3775
                        if (entity.isEndpoint(graph) && !entity.isConnected(graph)) {
                            r += 1.5;
                        }

                        d3_select(this)
                            .attr('cx', c)
                            .attr('cy', -c)
                            .attr('r', r)
                            .attr('visibility', ((i && klass === 'fill') ? 'hidden' : null));
                    });
            });

            selection.selectAll('use')
                .attr('visibility', (z === 0 ? 'hidden' : null));
        }


        var groups = selection.selectAll('.vertex.' + klass)
            .filter(filter)
            .data(vertices, osmEntity.key);

        // exit
        groups.exit()
            .remove();

        // enter
        var enter = groups.enter()
            .append('g')
            .attr('class', function(d) { return 'node vertex ' + klass + ' ' + d.id; });

        enter
            .append('circle')
            .each(setClass('shadow'));

        enter
            .append('circle')
            .each(setClass('stroke'));

        // Vertices with icons get a `use`.
        enter.filter(function(d) { return getIcon(d); })
            .append('use')
            .attr('transform', 'translate(-5, -6)')
            .attr('xlink:href', function(d) {
                var picon = getIcon(d);
                var isMaki = dataFeatureIcons.indexOf(picon) !== -1;
                return '#' + picon + (isMaki ? '-11' : '');
            })
            .attr('width', '11px')
            .attr('height', '11px')
            .each(setClass('icon'));

        // Vertices with tags get a fill.
        enter.filter(function(d) { return d.hasInterestingTags(); })
            .append('circle')
            .each(setClass('fill'));

        // update
        groups = groups
            .merge(enter)
            .attr('transform', svgPointTransform(projection))
            .classed('sibling', function(entity) { return entity.id in siblings; })
            .classed('shared', function(entity) { return graph.isShared(entity); })
            .classed('endpoint', function(entity) { return entity.isEndpoint(graph); })
            .call(updateAttributes);


        // Directional vertices get viewfields
        var dgroups = groups.filter(function(d) { return getDirections(d); })
            .selectAll('.viewfieldgroup')
            .data(function data(d) { return zoom < 18 ? [] : [d]; }, osmEntity.key);

        // exit
        dgroups.exit()
            .remove();

        // enter/update
        dgroups = dgroups.enter()
            .insert('g', '.shadow')
            .each(setClass('viewfieldgroup'))
            .merge(dgroups);

        var viewfields = dgroups.selectAll('.viewfield')
            .data(getDirections, function key(d) { return d; });

        // exit
        viewfields.exit()
            .remove();

        // enter/update
        viewfields.enter()
            .append('path')
            .attr('class', 'viewfield')
            .attr('d', 'M0,0H0')
            .merge(viewfields)
            .attr('marker-start', 'url(#viewfield-marker' + (wireframe ? '-wireframe' : '') + ')')
            .attr('transform', function(d) { return 'rotate(' + d + ')'; });
    }


    function drawVertices(selection, graph, entities, filter, extent) {
        var wireframe = context.surface().classed('fill-wireframe');
        var zoom = ktoz(projection.scale());

        var siblings = {};
        getSiblingAndChildVertices(context.selectedIDs(), graph, extent);

        // always render selected and sibling vertices..
        var vertices = _clone(siblings);
        var filterWithSiblings = function(d) { return d.id in siblings || filter(d); };

        // also render important vertices from the `entities` list..
        for (var i = 0; i < entities.length; i++) {
            var entity = entities[i];
            var geometry = entity.geometry(graph);

            if ((geometry === 'point') && renderAsVertex(entity)) {
                vertices[entity.id] = entity;

            } else if ((geometry === 'vertex') &&
                (entity.hasInterestingTags() || entity.isEndpoint(graph) || entity.isConnected(graph)) ) {
                vertices[entity.id] = entity;
            }
        }


        selection.selectAll('.layer-hit')
            .call(draw, _values(vertices), 'vertex-persistent', graph, siblings, filterWithSiblings);

//         drawHover(selection, graph, extent, true);


        // Points can also render as vertices:
        // 1. in wireframe mode or
        // 2. at higher zooms if they have a direction
        function renderAsVertex(entity) {
            var geometry = entity.geometry(graph);
            return geometry === 'vertex' || (geometry === 'point' && (
                wireframe || (zoom > 18 && entity.directions(graph, projection).length)
            ));
        }


        function getSiblingAndChildVertices(ids, graph, extent) {

            function addChildVertices(entity) {
                var geometry = entity.geometry(graph);
                if (!context.features().isHiddenFeature(entity, graph, geometry)) {
                    var i;
                    if (entity.type === 'way') {
                        for (i = 0; i < entity.nodes.length; i++) {
                            var child = context.hasEntity(entity.nodes[i]);
                            if (child) {
                                addChildVertices(child);
                            }
                        }
                    } else if (entity.type === 'relation') {
                        for (i = 0; i < entity.members.length; i++) {
                            var member = context.hasEntity(entity.members[i].id);
                            if (member) {
                                addChildVertices(member);
                            }
                        }
                    } else if (renderAsVertex(entity) && entity.intersects(extent, graph)) {
                        siblings[entity.id] = entity;
                    }
                }
            }

            ids.forEach(function(id) {
                var entity = context.hasEntity(id);
                if (!entity) return;

                if (entity.type === 'node') {
                    if (renderAsVertex(entity)) {
                        siblings[entity.id] = entity;
                        graph.parentWays(entity).forEach(function(entity) {
                            addChildVertices(entity);
                        });
                    }
                } else {  // way, relation
                    addChildVertices(entity);
                }
            });

        }
    }


//     function drawHover(selection, graph, extent, follow) {
//         var hovered = _hover ? siblingAndChildVertices([_hover.id], graph, extent) : {};
//         var wireframe = context.surface().classed('fill-wireframe');
//         var layer = selection.selectAll('.layer-hit');
//
//         layer.selectAll('g.vertex.vertex-hover')
//             .call(draw, _values(hovered), 'vertex-hover', graph, {}, false);
//     }
//
//
//     drawVertices.drawHover = function(selection, graph, target, extent) {
//         if (target === _hover) return;
//         _hover = target;
//         drawHover(selection, graph, extent);
//     };

    return drawVertices;
}
