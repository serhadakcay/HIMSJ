import Foundation
import Contacts
import WebKit

class IOSContactsBridge: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "insertContact",
              let body = message.body as? [String: String],
              let name = body["name"],
              let phone = body["phone"] else { return }

        let store = CNContactStore()
        store.requestAccess(for: .contacts) { granted, _ in
            guard granted else { return }
            let contact = CNMutableContact()
            contact.givenName = name
            contact.phoneNumbers = [CNLabeledValue(label: CNLabelPhoneNumberMobile, value: CNPhoneNumber(stringValue: phone))]

            let saveRequest = CNSaveRequest()
            saveRequest.add(contact, toContainerWithIdentifier: nil)
            try? store.execute(saveRequest)
        }
    }
}
