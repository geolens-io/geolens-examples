# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "geolens==1.31.0",
# ]
# ///
"""List published stories, read a dashboard, and recompute its numbers.

Run it with no setup at all:

    uv run stories-dashboards.py

A map dashboard stores its widgets as configuration: a column, a statistic and
a layer. The numbers on screen are not stored. Each one is a call to the
aggregate route, so a script can ask the same question and get the same answer.

What it does: lists the published stories, picks the dashboard with the most
widgets, recomputes an indicator and a pie chart from its configuration, and
checks the two against each other. Then it finds a chart whose column holds
empty strings and shows what blank_text_as_null does to it.

These routes send no CORS headers to other origins, so this is a script and not
a browser page. Both are anonymous on the demo. The widgets are described in
https://docs.getgeolens.com/guides/user/dashboards/ and the request bodies in
https://docs.getgeolens.com/guides/api/reference/operations/aggregate_endpoint_datasets__dataset_id__aggregate__post/
"""

from __future__ import annotations

import os
import sys
import time
from uuid import UUID

from geolens import GeolensClient
from geolens.api.datasets_analysis import (
    aggregate_endpoint_datasets_dataset_id_aggregate_post as aggregate,
)
from geolens.api.maps import get_map_endpoint_maps_map_id_get as get_map
from geolens.api.maps import list_maps_endpoint_maps_get as list_maps
from geolens.api.stories import list_stories_endpoint_stories_get as list_stories
from geolens.models.count_request import CountRequest
from geolens.models.stats_request import StatsRequest
from geolens.models.value_counts_request import ValueCountsRequest

if os.environ.get("GEOLENS_URL") and not os.environ.get("GEOLENS_INSTANCE"):
    sys.exit("GEOLENS_URL was renamed to GEOLENS_INSTANCE; export that instead.")

BASE_URL = os.environ.get("GEOLENS_INSTANCE") or "https://demo.getgeolens.com"
API_BASE = f"{BASE_URL.rstrip('/')}/api"
API_KEY = os.environ.get("GEOLENS_API_KEY") or None

# Charts that group a column and count rows. A bar or pie chart that sums a
# second column needs the group_by operation instead, which this script skips.
COUNT_CHARTS = ("pie_chart", "bar_chart")


def ok(response, what: str):
    # Anonymous callers get 10 requests a second, and the dashboard scan below
    # makes more than that in a burst.
    time.sleep(0.15)
    if response.status_code != 200:
        detail = getattr(response.parsed, "detail", None) or response.content[:200]
        sys.exit(f"\n  {what} failed: HTTP {response.status_code}, {detail}")
    return response.parsed


def main() -> int:
    print(f"Reading {BASE_URL} ...")
    client = GeolensClient(base_url=API_BASE, api_key=API_KEY).client

    stories = ok(list_stories.sync_detailed(client=client, published_only=True), "stories")
    dashboards = []
    for summary in ok(list_maps.sync_detailed(client=client, limit=200), "maps").maps:
        if summary.has_dashboard:
            full = ok(get_map.sync_detailed(summary.id, client=client), "map")
            if full.dashboard_config:
                dashboards.append((full.name, full.dashboard_config.to_dict(), full.layers))
    if not dashboards:
        sys.exit(f"\n  {BASE_URL} has no map with a dashboard")

    def values(dataset_id: UUID, column: str, limit: int = 50, **options):
        body = ValueCountsRequest(op="value_counts", column=column, limit=limit, **options)
        return ok(aggregate.sync_detailed(dataset_id, client=client, body=body), "value_counts").result

    def chart_targets(config, layers):
        by_layer = {str(layer.id): layer.dataset_id for layer in layers}
        for widget in config["widgets"]:
            col = widget.get("config", {}).get("column")
            if widget["type"] in COUNT_CHARTS and col and widget["config"].get("stat") == "count":
                yield widget, by_layer[widget["layer_id"]], col

    def count_indicator(widgets):
        return next(
            (w for w in widgets if w["type"] == "indicator" and w.get("config", {}).get("stat") == "count"),
            None,
        )

    # The busiest dashboard that has both a count indicator and a count chart,
    # ties broken by name, so the pick does not depend on the order the server
    # lists maps in.
    usable = [
        d
        for d in dashboards
        if count_indicator(d[1]["widgets"]) and next(chart_targets(d[1], d[2]), None)
    ]
    if not usable:
        sys.exit(f"\n  no dashboard on {BASE_URL} has both a count indicator and a count chart")
    name, config, layers = max(usable, key=lambda d: (len(d[1]["widgets"]), d[0]))
    widgets = config["widgets"]
    by_layer = {str(layer.id): layer.dataset_id for layer in layers}

    indicator = count_indicator(widgets)
    summed = next(
        (
            w
            for w in widgets
            if w["type"] == "indicator"
            and w.get("config", {}).get("stat") == "sum"
            and w["config"].get("column")
        ),
        None,
    )
    chart, chart_dataset, chart_column = next(chart_targets(config, layers))

    # The dashboard's "count" indicator is the aggregate route's count op.
    count_dataset = by_layer[indicator["layer_id"]]
    total = ok(
        aggregate.sync_detailed(count_dataset, client=client, body=CountRequest(op="count")),
        "count",
    ).result.count

    stat_line = ""
    if summed:
        stats = ok(
            aggregate.sync_detailed(
                by_layer[summed["layer_id"]],
                client=client,
                body=StatsRequest(op="stats", column=summed["config"]["column"], stats=["sum"]),
            ),
            "stats",
        ).result
        stat_line = f"  {summed['title']:<44} {stats.sum_:>16,.0f}"

    groups = values(chart_dataset, chart_column, chart["config"].get("limit", 10))
    grouped = sum(v.count for v in groups.values) + groups.other_count

    # Hunt across every dashboard for a text column where empty strings and
    # NULLs are counted apart. blank_text_as_null (1.31.0) merges them.
    blank = None
    for dash_name, dash_config, dash_layers in sorted(dashboards, key=lambda d: d[0]):
        for widget, dataset_id, column in chart_targets(dash_config, dash_layers):
            before = values(dataset_id, column)
            after = values(dataset_id, column, blank_text_as_null=True)
            if any(v.value == "" for v in before.values) and not any(v.value == "" for v in after.values):
                blank = (dash_name, widget["title"], column, before, after)
                break
        if blank:
            break

    w = 62
    print()
    print("STORIES AND DASHBOARDS".center(w).rstrip())
    print("-" * w)
    print(f"  published stories   {stories.total:>4}")
    for story in stories.stories:
        print(f"    {story.chapter_count:>2} chapters  {story.title}")
    print()
    print(f"  dashboards          {len(dashboards):>4}")
    for dash_name, dash_config, _ in sorted(dashboards, key=lambda d: d[0]):
        mark = "*" if dash_name == name else " "
        print(f"   {mark}{len(dash_config['widgets']):>2} widgets  {dash_name}")
    print()
    print(f"  recomputed from the config of: {name}")
    print(f"  {indicator['title']:<44} {total:>16,}   count")
    if stat_line:
        print(f"{stat_line}   stats")
    print(f"  {chart['title']}: first {len(groups.values)} groups of {chart_column}")
    for v in groups.values:
        print(f"    {v.count:>8,}  {v.value}")
    print(f"    {groups.other_count:>8,}  other")
    if grouped != total and chart["layer_id"] == indicator["layer_id"]:
        sys.exit(f"\n  the chart groups {grouped:,} rows but the indicator counts {total:,}")
    print()
    if blank:
        dash_name, title, column, before, after = blank
        empty = next(v.count for v in before.values if v.value == "")
        null = next((v.count for v in before.values if v.value is None), 0)
        merged = next(v.count for v in after.values if v.value is None)
        print(f"  {title} ({dash_name}), column {column}")
        print(f"    default             '' {empty:,}   null {null:,}")
        print(f"    blank_text_as_null  null {merged:,}")
    else:
        print("  no dashboard chart has empty strings in its column right now")
    print("-" * w)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
