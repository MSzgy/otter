import SwiftUI
import VisionKit

// First run: scan the QR code from the Mac (设置 → 手机 → 添加手机), or paste
// its link where there is no camera.
struct PairView: View {
  @Environment(SyncStore.self) private var store
  @Environment(\.palette) private var palette
  @State private var link = ""
  @State private var scanning = false

  var body: some View {
    @Bindable var store = store
    ScrollView {
      VStack(spacing: 20) {
        Image("otter-waving")
          .interpolation(.none)
          .resizable()
          .scaledToFit()
          .frame(width: 150, height: 150)
          .padding(.top, 40)
        VStack(spacing: 8) {
          Text("连上你的 Mac").font(.rounded(26, .bold)).foregroundStyle(palette.ink)
          Text("在 Mac 上打开 Otter → 设置 → 手机，打开“允许手机连接”，点“添加手机”，再扫它显示的二维码。手机和 Mac 要在同一个 Wi-Fi。")
            .font(.rounded(15))
            .foregroundStyle(palette.muted)
            .multilineTextAlignment(.center)
        }
        if DataScannerViewController.isSupported {
          Button {
            scanning = true
          } label: {
            Label("扫描二维码", systemImage: "qrcode.viewfinder")
              .font(.rounded(17, .semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 14)
          }
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
        }
        Card {
          Text("或者粘贴配对链接").font(.rounded(13, .medium)).foregroundStyle(palette.muted)
          TextField("otter://pair?d=…", text: $link, axis: .vertical)
            .font(.system(size: 13, design: .monospaced))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel("配对链接")
          Button("配对") { store.pair(link) }
            .font(.rounded(15, .semibold))
            .disabled(link.isEmpty || store.pairing)
        }
        if store.pairing {
          ProgressView("正在配对…").font(.rounded(14))
        }
        if let error = store.pairingError {
          Text(error)
            .font(.rounded(14))
            .foregroundStyle(.red)
            .multilineTextAlignment(.center)
            .accessibilityLabel("配对出错：\(error)")
        }
      }
      .padding(24)
    }
    .background(palette.background.ignoresSafeArea())
    .sheet(isPresented: $scanning) {
      QRScanner { text in
        scanning = false
        store.pair(text)
      }
      .ignoresSafeArea()
    }
  }
}

// VisionKit's live scanner, stopping at the first Otter link it sees.
struct QRScanner: UIViewControllerRepresentable {
  let found: (String) -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .fast,
      isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(found: found) }

  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let found: (String) -> Void
    private var done = false
    init(found: @escaping (String) -> Void) { self.found = found }

    func dataScanner(
      _ scanner: DataScannerViewController, didAdd items: [RecognizedItem],
      allItems: [RecognizedItem]
    ) {
      for case .barcode(let code) in items {
        guard !done, let text = code.payloadStringValue, text.hasPrefix("otter://pair") else {
          continue
        }
        done = true
        scanner.stopScanning()
        found(text)
      }
    }
  }
}
