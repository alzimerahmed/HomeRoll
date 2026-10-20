import { Link, Row, Text } from 'react-email';
import * as React from 'react';
import ImmichLayout from 'src/emails/components/immich.layout.js';
import { TestEmailProps } from 'src/repositories/email.repository.js';

export const TestEmail = ({ baseUrl, displayName }: TestEmailProps) => (
  <ImmichLayout preview="This is a test email from HomeRoll.">
    <Text className="m-0">
      Hey <strong>{displayName}</strong>!
    </Text>

    <Text>This is a test email from your HomeRoll Instance!</Text>

    <Row>
      <Link href={baseUrl}>{baseUrl}</Link>
    </Row>
  </ImmichLayout>
);

TestEmail.PreviewProps = {
  baseUrl: 'https://demo.homeroll.test',
  displayName: 'Alan Turing',
} as TestEmailProps;

export default TestEmail;
