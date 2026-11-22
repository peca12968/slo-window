"""Create two OTLP/HTTP request bodies using the OpenTelemetry Python SDK."""

import argparse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from threading import Thread

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor, SpanExportResult
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator


def generate():
    providers = []
    memory = InMemorySpanExporter()

    def tracer(service):
        provider = TracerProvider(resource=Resource({"service.name": service}))
        provider.add_span_processor(SimpleSpanProcessor(memory))
        providers.append(provider)
        return provider.get_tracer("checkout-demo")

    start = 1_760_000_000_000_000_000
    ms = 1_000_000
    try:
        root = tracer("checkout").start_span("checkout", start_time=start)
        headers = {}
        propagator = TraceContextTextMapPropagator()
        propagator.inject(headers, context=trace.set_span_in_context(root))
        remote = propagator.extract(headers)
        stock = tracer("inventory").start_span("reserve stock", context=remote, start_time=start + 10 * ms)
        payments = tracer("payments")
        pay = payments.start_span("charge card", context=remote, start_time=start + 40 * ms)
        bank = payments.start_span("bank authorization", context=trace.set_span_in_context(pay),
                                   start_time=start + 50 * ms)
        stock.end(end_time=start + 70 * ms)
        bank.end(end_time=start + 80 * ms)
        pay.end(end_time=start + 100 * ms)
        root.end(end_time=start + 120 * ms)
        return memory.get_finished_spans()
    finally:
        for provider in providers:
            provider.shutdown()


def capture(directory):
    bodies = []

    class Receiver(BaseHTTPRequestHandler):
        def do_POST(self):
            if self.path != "/v1/traces" or self.headers.get("Content-Type") != "application/x-protobuf":
                self.send_error(400)
                return
            bodies.append(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.send_header("Content-Type", "application/x-protobuf")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    spans = generate()
    with HTTPServer(("127.0.0.1", 0), Receiver) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            exporter = OTLPSpanExporter(endpoint=f"http://127.0.0.1:{server.server_port}/v1/traces",
                                        compression=Compression.NoCompression, timeout=3)
            try:
                # Root and downstream services can export in separate batches.
                for group in ([s for s in spans if s.parent is None], [s for s in spans if s.parent is not None]):
                    if exporter.export(group) != SpanExportResult.SUCCESS:
                        raise RuntimeError("loopback OTLP export failed")
            finally:
                exporter.shutdown()
        finally:
            server.shutdown()
            thread.join()
    if len(bodies) != 2:
        raise RuntimeError("expected two OTLP request bodies")
    directory.mkdir(parents=True, exist_ok=True)
    for name, body in zip(("checkout.otlp", "services.otlp"), bodies, strict=True):
        (directory / name).write_bytes(body)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    capture(parser.parse_args().directory)
